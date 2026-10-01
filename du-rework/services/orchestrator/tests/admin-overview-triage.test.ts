import {
  fetchOverview,
  resolveOverviewPresetWindow,
  resolveWindow,
} from '../src/app/admin/overview-section-data';
import { renderOverviewSection } from '../src/app/admin/overview-section-renderer';
import { parseOperationListQuery } from '../src/app/admin/shell-router';
import {
  OPERATION_LIST_CURSOR_MAX_LEN,
  OPERATION_LIST_DEFAULT_LIMIT,
  OPERATION_LIST_MAX_LIMIT,
} from '../src/app/admin/operation-section-data';

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


// ===========================================================================
// W-ADM-UX-14-OVERVIEW-TRIAGE-NEGATIVE (Turn 344 / Cycle 58)
//
// Negative + boundary tests for the overview triage viewport. Every
// expectation was MEASURED with a throwaway probe against the real function
// first. Where behaviour is arguably wrong it is marked DEFECT and reported,
// not fixed (production code is out of scope).
//
// fetchImpl is injected, so no listener is bound and no port band applies.
// ===========================================================================

const T58_XSS = '<script>alert(1)</script>';

const T58_INVALID_TOTAL = 'The operations list returned an invalid total count.';
const T58_NO_TOTAL = 'The operations list did not provide a total count.';
const T58_INCOMPLETE = 'Queue integrity returned an incomplete snapshot.';
const T58_NO_SNAPSHOT = 'Queue integrity has not published a snapshot.';

function t58Json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Counts per operation state. hasOwnProperty, never `??`: a null total must
 *  reach the view model as null so the negative case is genuinely exercised. */
function t58Stub(
  counts: Record<string, unknown>,
  health: unknown = null,
  tenantId = 'tenant_a',
): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    if (href.includes('/api/v1/usage')) return t58Json({ tenantId, rows: [], totals: {} });
    if (href.includes('/api/v1/admin/audit')) {
      return t58Json({ tenantId, items: [], total: 0, limit: 50 });
    }
    if (href.includes('/api/v1/health')) {
      return health === null
        ? t58Json({ status: 'ok', db: true, redis: true, activeLeases: 0 })
        : t58Json(health);
    }
    const state = new URL(href).searchParams.get('state') ?? '';
    return Object.prototype.hasOwnProperty.call(counts, state)
      ? t58Json({ items: [], total: counts[state], limit: 1 })
      : t58Json({ items: [], total: 0, limit: 1 });
  }) as unknown as typeof fetch;
}

async function t58Fetch(
  counts: Record<string, unknown>,
  health: unknown = null,
  o: Record<string, unknown> = {},
) {
  return fetchOverview({
    tenantId: 'tenant_a',
    jsonBaseUrl: 'http://127.0.0.1:1',
    adminToken: 'test-token',
    fetchImpl: t58Stub(counts, health),
    ...o,
  } as never);
}

function t58Triage(result: unknown) {
  return (result as { bundle: { triage: Record<string, { status: string; value: number | null; detail?: string; sourceUpdatedAt?: string }> } })
    .bundle.triage;
}

/** fetchOverview stamps its own nowMs from the real clock, so every staleness
 *  fixture is relative to Date.now(). A fixed constant silently makes every row
 *  stale - I hit exactly that in the first probe run. */
function t58Health(over: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    db: true,
    redis: true,
    activeLeases: 0,
    queueIntegrity: {
      state: 'OK',
      stalled: 0,
      lastSweepAt: new Date(Date.now()).toISOString(),
      ...over,
    },
  };
}

function t58Ago(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Non-ok results carry triage at the TOP level rather than under bundle. */
function t58TopTriage(result: unknown): Record<string, { status: string; value: number | null }> {
  return (result as unknown as { triage: Record<string, { status: string; value: number | null }> }).triage;
}

// ---------------------------------------------------------------------------
// 1. Triage count thresholds - all fail closed
// ---------------------------------------------------------------------------

describe('W-ADM-UX-14: a corrupt operation total never becomes a number', () => {
  const invalid: unknown[] = [-1, 1.5, 1e21];
  test.each(invalid)('total %p is rejected as an invalid count', async (total) => {
    const result = await t58Fetch({ FAILED: total });
    expect(result.kind).toBe('ok');
    const failed = t58Triage(result).failed as { status: string; value: number | null; detail?: string };
    expect(failed.status).toBe('unavailable');
    expect(failed.value).toBeNull();
    expect(failed.detail).toBe(T58_INVALID_TOTAL);
  });

  const noTotal: unknown[] = ['5', null, true];
  test.each(noTotal)('total %p is treated as no count at all', async (total) => {
    const result = await t58Fetch({ FAILED: total });
    const failed = t58Triage(result).failed as { status: string; value: number | null; detail?: string };
    expect(failed.status).toBe('unavailable');
    expect(failed.detail).toBe(T58_NO_TOTAL);
  });

  test('a missing total is unavailable, not zero', async () => {
    const fetchImpl = (async (url: unknown) => {
      const href = String(url);
      if (href.includes('/api/v1/usage')) return t58Json({ rows: [], totals: {} });
      if (href.includes('/api/v1/admin/audit')) return t58Json({ items: [], total: 0 });
      if (href.includes('/api/v1/health')) return t58Json({ status: 'ok', db: true, redis: true, activeLeases: 0 });
      return t58Json({ items: [] });
    }) as unknown as typeof fetch;
    const result = await fetchOverview({
      tenantId: 't',
      jsonBaseUrl: 'http://127.0.0.1:1',
      adminToken: 't',
      fetchImpl,
    } as never);
    const failed = t58Triage(result).failed as { status: string; detail?: string };
    expect(failed.status).toBe('unavailable');
    expect(failed.detail).toBe(T58_NO_TOTAL);
  });

  test('a real zero is available and is NOT confused with a missing count', async () => {
    const result = await t58Fetch({ FAILED: 0, TIMED_OUT: 0, RUNNING: 0 });
    const triage = t58Triage(result);
    expect(triage.failed).toMatchObject({ status: 'available', value: 0 });
    expect(triage.timedOut).toMatchObject({ status: 'available', value: 0 });
    expect(triage.pending).toMatchObject({ status: 'available', value: 0 });
  });

  test('a real count is available (control)', async () => {
    const result = await t58Fetch({ FAILED: 4, TIMED_OUT: 3, RUNNING: 7 });
    const triage = t58Triage(result);
    expect(triage.failed).toMatchObject({ status: 'available', value: 4 });
    expect(triage.timedOut).toMatchObject({ status: 'available', value: 3 });
    expect(triage.pending).toMatchObject({ status: 'available', value: 7 });
  });

  test('each state is read from its own endpoint, so a corrupt FAILED does not blank the others', async () => {
    const result = await t58Fetch({ FAILED: -1, TIMED_OUT: 3, RUNNING: 7 });
    const triage = t58Triage(result);
    expect(triage.failed).toMatchObject({ status: 'unavailable' });
    expect(triage.timedOut).toMatchObject({ status: 'available', value: 3 });
    expect(triage.pending).toMatchObject({ status: 'available', value: 7 });
  });

  test('connectorDegradations is always unavailable - empty results are not evidence of health', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health());
    expect(t58Triage(result).connectorDegradations).toMatchObject({ status: 'unavailable', value: null });
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Severity / staleness thresholds
// ---------------------------------------------------------------------------

describe('W-ADM-UX-14: queue integrity rejects an unknown state and a corrupt snapshot', () => {
  const badStates: unknown[] = ['BOGUS', '', null, 'ok'];
  test.each(badStates)('queueIntegrity.state %p is rejected', async (state) => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ state }));
    const lag = t58Triage(result).queueLag as { status: string; value: number | null; detail?: string };
    expect(lag.status).toBe('unavailable');
    expect(lag.value).toBeNull();
    expect(lag.detail).toBe(T58_INCOMPLETE);
  });

  const goodStates = ['OK', 'RECONSTRUCTING', 'SUSPECT'];
  test.each(goodStates)('queueIntegrity.state %p is accepted', async (state) => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ state }));
    expect(t58Triage(result).queueLag).toMatchObject({ status: 'available' });
  });

  const badStalled: unknown[] = [-1, 1.5, '2', null];
  test.each(badStalled)('stalled %p is rejected', async (stalled) => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ stalled }));
    expect(t58Triage(result).queueLag).toMatchObject({ status: 'unavailable', detail: T58_INCOMPLETE });
  });

  const badSweeps: unknown[] = ['garbage', '', null, 12345];
  test.each(badSweeps)('lastSweepAt %p is rejected', async (lastSweepAt) => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ lastSweepAt }));
    expect(t58Triage(result).queueLag).toMatchObject({ status: 'unavailable', detail: T58_INCOMPLETE });
  });

  test('an absent queueIntegrity block says it never published, not that it failed', async () => {
    const absent = await t58Fetch({ FAILED: 1 }, { status: 'ok', db: true, redis: true, activeLeases: 0 });
    expect(t58Triage(absent).queueLag).toMatchObject({
      status: 'unavailable',
      value: null,
      detail: T58_NO_SNAPSHOT,
    });
    const explicitNull = await t58Fetch({ FAILED: 1 }, {
      status: 'ok',
      db: true,
      redis: true,
      activeLeases: 0,
      queueIntegrity: null,
    });
    expect(t58Triage(explicitNull).queueLag).toMatchObject({ status: 'unavailable' });
  });

  test('a stale snapshot still reports its value - stale is not unavailable', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ state: 'SUSPECT', stalled: 2, lastSweepAt: t58Ago(-300_000) }));
    expect(t58Triage(result).queueLag).toMatchObject({
      status: 'stale',
      value: 2,
      detail: 'Integrity SUSPECT',
    });
  });
});

describe('W-ADM-UX-14: the staleness clock has a 120s past bound and a 60s future tolerance', () => {
  // stale = ageMs > 120_000 || ageMs < -60_000. The fixture is 2s either side
  // of the bound so the round-trip through fetchOverview cannot flip the row.
  test('a sweep 5s old is available', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ lastSweepAt: t58Ago(-5_000) }));
    expect(t58Triage(result).queueLag).toMatchObject({ status: 'available' });
  });

  test('a sweep 119s old is still available', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ lastSweepAt: t58Ago(-119_000) }));
    expect(t58Triage(result).queueLag).toMatchObject({ status: 'available' });
  });

  test('a sweep 121s old is stale', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ lastSweepAt: t58Ago(-121_000) }));
    expect(t58Triage(result).queueLag).toMatchObject({ status: 'stale' });
  });

  test('a sweep 30s in the future is tolerated - small clock skew is not staleness', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ lastSweepAt: t58Ago(30_000) }));
    expect(t58Triage(result).queueLag).toMatchObject({ status: 'available' });
  });

  // DEFECT-shaped observation: a source clock running more than a minute fast
  // reads as stale even though nothing is wrong with the snapshot.
  test('a sweep 120s in the future is stale - a fast source clock looks like a bad one', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ lastSweepAt: t58Ago(120_000) }));
    expect(t58Triage(result).queueLag).toMatchObject({ status: 'stale' });
  });

  test('a stale sweep exposes sourceUpdatedAt so the operator can judge the skew', async () => {
    const stamp = t58Ago(-300_000);
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ state: 'OK', lastSweepAt: stamp }));
    const lag = t58Triage(result).queueLag as { sourceUpdatedAt?: string };
    expect(lag.sourceUpdatedAt).toBe(new Date(stamp).toISOString());
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid date bounds
// ---------------------------------------------------------------------------

describe('W-ADM-UX-14: window bounds are never parsed, ordered or validated', () => {
  const NOW = Date.parse('2026-09-30T12:00:00.000Z');

  // DEFECT: resolveWindow only checks for emptiness. A non-empty but invalid
  // bound is copied verbatim, and fetchOverview then puts it straight into the
  // outbound query string.
  test('garbage bounds pass through verbatim', () => {
    expect(resolveWindow('garbage', 'nonsense', NOW)).toEqual({ from: 'garbage', to: 'nonsense' });
  });

  test('an inverted window (to before from) passes through unflagged', () => {
    expect(resolveWindow('2026-09-30T00:00:00Z', '2026-01-01T00:00:00Z', NOW)).toEqual({
      from: '2026-09-30T00:00:00Z',
      to: '2026-01-01T00:00:00Z',
    });
  });

  test('empty bounds fall back to the current UTC day (control)', () => {
    expect(resolveWindow('', '', NOW)).toEqual({
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-09-30T12:00:00.000Z',
    });
    expect(resolveWindow(undefined, undefined, NOW)).toEqual({
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-09-30T12:00:00.000Z',
    });
  });

  test('garbage bounds reach the fetch result and the outbound query string', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      seen.push(String(url));
      const href = String(url);
      if (href.includes('/api/v1/usage')) return t58Json({ rows: [], totals: {} });
      if (href.includes('/api/v1/admin/audit')) return t58Json({ items: [], total: 0 });
      if (href.includes('/api/v1/health')) return t58Json({ status: 'ok', db: true, redis: true, activeLeases: 0 });
      return t58Json({ items: [], total: 1, limit: 1 });
    }) as unknown as typeof fetch;

    const result = await fetchOverview({
      tenantId: 't',
      jsonBaseUrl: 'http://127.0.0.1:1',
      adminToken: 't',
      fetchImpl,
      timePreset: 'custom',
      from: 'garbage',
      to: 'nonsense',
    } as never);
    expect(result.from).toBe('garbage');
    expect(result.to).toBe('nonsense');
    const usage = seen.find((u) => u.includes('/api/v1/usage'))!;
    expect(usage).toContain('from=garbage');
    expect(usage).toContain('to=nonsense');
  });

  test('an inverted window also survives into the result', async () => {
    const result = await t58Fetch({ FAILED: 1 }, null, {
      timePreset: 'custom',
      from: '2026-09-30T00:00:00Z',
      to: '2026-01-01T00:00:00Z',
    });
    expect(result.from).toBe('2026-09-30T00:00:00Z');
    expect(result.to).toBe('2026-01-01T00:00:00Z');
  });

  test('an unknown preset silently becomes the current UTC day and drops the bounds', () => {
    // DEFECT: no error, no warning. A typo in the preset narrows the window to
    // one day while the caller still believes it asked for something else.
    expect(resolveOverviewPresetWindow('BOGUS' as never, 'garbage', 'nonsense', NOW)).toEqual({
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-09-30T12:00:00.000Z',
    });
  });

  test('24h and 7d discard caller-supplied bounds entirely', () => {
    expect(resolveOverviewPresetWindow('24h', 'garbage', 'nonsense', NOW)).toEqual({
      from: '2026-09-29T12:00:00.000Z',
      to: '2026-09-30T12:00:00.000Z',
    });
    expect(resolveOverviewPresetWindow('7d', 'garbage', 'nonsense', NOW)).toEqual({
      from: '2026-09-23T12:00:00.000Z',
      to: '2026-09-30T12:00:00.000Z',
    });
  });

  test('custom passes the bounds through, and empty custom bounds fall back', () => {
    expect(resolveOverviewPresetWindow('custom', 'garbage', 'nonsense', NOW)).toEqual({
      from: 'garbage',
      to: 'nonsense',
    });
    expect(resolveOverviewPresetWindow('custom', '', '', NOW)).toEqual({
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-09-30T12:00:00.000Z',
    });
  });

  test('undefined and today both mean the current UTC day (control)', () => {
    expect(resolveOverviewPresetWindow(undefined, undefined, undefined, NOW)).toEqual({
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-09-30T12:00:00.000Z',
    });
    expect(resolveOverviewPresetWindow('today', 'garbage', 'nonsense', NOW)).toEqual({
      from: '2026-09-30T00:00:00.000Z',
      to: '2026-09-30T12:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// 5. XSS-like payloads
// ---------------------------------------------------------------------------

describe('W-ADM-UX-14: hostile tenant and severity payloads never reach the DOM raw', () => {
  test('a hostile tenant id is HTML-escaped and URL-encoded in the filter link', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health(), { tenantId: T58_XSS });
    const html = renderOverviewSection({
      fetch: result,
      selectedTenantId: T58_XSS,
      selectedTimePreset: '24h',
    } as never).html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('state=FAILED&amp;tenant=');
  });

  test('a hostile queueIntegrity state is rejected before it can be interpolated', () => {
    // The severity allowlist runs first, so the payload never reaches the
    // detail string and therefore never reaches the renderer at all. The fix
    // is the allowlist, not the escaper.
    void T58_XSS;
  });

  test('a hostile severity state is dropped at the allowlist, so the payload is not even rendered', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health({ state: T58_XSS, stalled: 2 }));
    const html = renderOverviewSection({ fetch: result, selectedTenantId: 'tenant_a' } as never).html;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(T58_XSS);
    expect(html).toContain('data-metric-status="unavailable"');
  });

  test('a hostile preset is not reflected and simply leaves nothing selected', async () => {
    const result = await t58Fetch({ FAILED: 1 }, t58Health());
    const html = renderOverviewSection({
      fetch: result,
      selectedTenantId: 'tenant_a',
      selectedTimePreset: 'BOGUS' as never,
    } as never).html;
    expect(html).not.toContain('<script>');
    // No <option> is marked selected: the unknown preset matches nothing in
    // the preset list. Scoped to the option tag because the string 'selected'
    // also appears in data-overview-tenant-selected.
    expect(html).not.toMatch(/<option[^>]*\bselected/);
    expect(html).toContain('<option value="today">');
  });
});

// ---------------------------------------------------------------------------
// 6. Empty and non-ok states
// ---------------------------------------------------------------------------

describe('W-ADM-UX-14: missing credentials and dead sources degrade without inventing zeroes', () => {
  test('no admin token is unauthorized and every triage metric is unavailable', async () => {
    const result = await fetchOverview({
      tenantId: 't',
      jsonBaseUrl: 'http://127.0.0.1:1',
      adminToken: '',
    } as never);
    expect(result.kind).toBe('unauthorized');
    const triage = t58TopTriage(result);
    expect(triage.failed!.status).toBe('unavailable');
  });

  test('an unparseable base URL is an error, not a crash', async () => {
    const result = await fetchOverview({
      tenantId: 't',
      jsonBaseUrl: 'not a url',
      adminToken: 't',
    } as never);
    expect(result.kind).toBe('error');
    expect((result as { message: string }).message).toBe('Invalid platform JSON API base URL.');
  });

  test('a dead platform is an error with a redacted message, never a raw throw', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1 with sk-secret-token');
    }) as unknown as typeof fetch;
    const result = await fetchOverview({
      tenantId: 't',
      jsonBaseUrl: 'http://127.0.0.1:1',
      adminToken: 't',
      fetchImpl,
    } as never);
    expect(result.kind).toBe('error');
    const message = (result as { message: string }).message;
    expect(message).toContain('Details redacted');
    expect(message).not.toContain('ECONNREFUSED');
    expect(message).not.toContain('sk-secret-token');
  });

  test('a non-JSON 200 response takes the same redacted error path', async () => {
    const fetchImpl = (async () => new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch;
    const result = await fetchOverview({
      tenantId: 't',
      jsonBaseUrl: 'http://127.0.0.1:1',
      adminToken: 't',
      fetchImpl,
    } as never);
    expect(result.kind).toBe('error');
    expect((result as { message: string }).message).toContain('Details redacted');
  });

  test('an error result still carries a triage snapshot, and no metric claims a zero', async () => {
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const result = await fetchOverview({
      tenantId: 't',
      jsonBaseUrl: 'http://127.0.0.1:1',
      adminToken: 't',
      fetchImpl,
    } as never);
    const triage = t58TopTriage(result);
    expect(triage.failed!.status).toBe('unavailable');
    expect(triage.failed!.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Renderer state wiring
// ---------------------------------------------------------------------------

describe('W-ADM-UX-14: unavailable metrics render without a link, stale ones keep theirs', () => {
  test('an unavailable metric renders as a plain span, not a link', async () => {
    const result = await t58Fetch({ FAILED: -1 }, t58Health());
    const html = renderOverviewSection({ fetch: result, selectedTenantId: 'tenant_a' } as never).html;
    expect(html).toContain('data-metric-status="unavailable"');
    expect(html).toContain('Source unavailable');
    expect(html).not.toContain('overview-section__metric-link" href="/admin/operations?state=FAILED');
  });

  test('a stale metric keeps its link because the value is still real', async () => {
    const result = await t58Fetch({ FAILED: 4 }, t58Health({ lastSweepAt: t58Ago(-300_000) }));
    const html = renderOverviewSection({ fetch: result, selectedTenantId: 'tenant_a' } as never).html;
    expect(html).toContain('data-metric-status="stale"');
    expect(html).toContain('Stale snapshot');
    expect(html).toContain('overview-section__metric-link');
  });

  test('an empty tenant drops the tenant query parameter from the filter link', async () => {
    const result = await t58Fetch({ FAILED: 4 }, null, { tenantId: '' });
    const html = renderOverviewSection({ fetch: result, selectedTenantId: '' } as never).html;
    expect(html).toContain('href="/admin/operations?state=FAILED"');
  });
});


// ===========================================================================
// W-ADM-UX-17-TRIAGE-VIEW-MODEL-NEGATIVE (Turn 344 / Cycle 61)
//
// Second negative pass over the same file as W-ADM-UX-14 (Mục 58). That pass
// covered the fetch-side thresholds (counts, queue integrity, staleness,
// windows, presets). This one deliberately stays off that ground and covers
// the surfaces that pass did not touch: the FILTER QUERY PARSER
// (parseOperationListQuery), PARTIAL triage snapshots, the metric STATUS string
// as it lands in a CSS class, and missing source timestamps. Every expectation
// was MEASURED with a throwaway probe first.
//
// Pure unit file: fetchImpl is injected and no listener is bound, so no port
// band applies.
// ===========================================================================

const T61_XSS = '<script>alert(1)</script>';
const T61_HEX64 = 'a'.repeat(64);

function t61Triage(over: Record<string, unknown> = {}) {
  return {
    failed: { status: 'available', value: 1 },
    timedOut: { status: 'available', value: 0 },
    pending: { status: 'available', value: 2 },
    queueLag: { status: 'available', value: 3 },
    connectorDegradations: { status: 'unavailable', value: null },
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...over,
  };
}

function t61Render(triage: unknown) {
  return renderOverviewSection({
    fetch: {
      kind: 'ok',
      tenantId: 't',
      from: 'a',
      to: 'b',
      bundle: { usage: null, audit: null, health: null, triage, serverNow: '2026-09-30T00:00:00.000Z' },
    },
  } as never).html;
}

// ---------------------------------------------------------------------------
// 1. Corrupt filter queries
// ---------------------------------------------------------------------------

describe('W-ADM-UX-17: the limit parser accepts a numeric prefix and clamps silently', () => {
  // Number.parseInt reads a PREFIX, so "12abc" is accepted as 12. Pinned so a
  // future switch to Number() shows up as a deliberate diff.
  test('a numeric prefix is accepted: "12abc" becomes 12', () => {
    expect(parseOperationListQuery({ limit: '12abc' }).limit).toBe(12);
  });

  const clamped: Array<[string, number]> = [
    ['-5', 1],
    ['0', 1],
    ['-0', 1],
    ['999', 100],
    ['1e3', 1],
    ['0x10', 1],
    ['1.9', 1],
    ['20.9', 20],
  ];
  test.each(clamped)('limit %p is clamped to %p', (raw, expected) => {
    expect(parseOperationListQuery({ limit: raw }).limit).toBe(expected);
  });

  const defaulted: string[] = ['abc', 'Infinity', 'NaN', '', '   '];
  test.each(defaulted)('limit %p falls back to the default 20', (raw) => {
    expect(parseOperationListQuery({ limit: raw }).limit).toBe(20);
  });

  test('an over-long numeric string is clamped, not rejected', () => {
    expect(parseOperationListQuery({ limit: '9'.repeat(30) }).limit).toBe(100);
  });

  test('surrounding whitespace is trimmed before parsing', () => {
    expect(parseOperationListQuery({ limit: ' 20 ' }).limit).toBe(20);
  });

  // The parser assumes a string and calls .trim() unguarded.
  test('a non-string limit throws rather than being ignored', () => {
    expect(() => parseOperationListQuery({ limit: 50 as never })).toThrow(TypeError);
  });

  test.each([undefined, {}])('an absent query object still yields a usable default', (query) => {
    const parsed = parseOperationListQuery(query as never);
    expect(parsed.limit).toBe(20);
    expect(parsed.cursor).toBeNull();
    expect(parsed.listFilters.state).toBe('ALL');
  });
});

describe('W-ADM-UX-17: the sanitized filters reject what the raw fields happily keep', () => {
  // The raw state field is a verbatim echo; listFilters.state is the sanitized
  // one the detail pane back-link uses. Both are measured.
  test.each([
    ['FAILED', 'FAILED'],
    ['failed', 'FAILED'],
    ['  FAILED  ', 'FAILED'],
    ['BOGUS', 'ALL'],
    [T61_XSS, 'ALL'],
    ['SUCCEEDED;DROP', 'ALL'],
  ])('state %p sanitizes to %p', (raw, expected) => {
    const parsed = parseOperationListQuery({ state: raw });
    expect(parsed.listFilters.state).toBe(expected);
  });

  test('the raw state field keeps the original spelling, spaces and all', () => {
    expect(parseOperationListQuery({ state: '  failed  ' }).stateFilter).toBe('  failed  ');
  });

  test.each(['', '   ', undefined])('state %p is dropped from the raw field and reads as ALL', (state) => {
    const parsed = parseOperationListQuery({ state: state as never });
    expect(parsed.stateFilter).toBeUndefined();
    expect(parsed.listFilters.state).toBe('ALL');
  });

  test('a non-string state falls back to ALL without throwing', () => {
    expect(parseOperationListQuery({ state: 5 as never }).listFilters.state).toBe('ALL');
  });

  // The security-relevant case: solid 32+ hex is raw API-key material, and the
  // token predicate rejects it on BOTH sides so a pasted secret can never act
  // as a search term. This is a guard worth pinning so nobody widens it.
  test('a solid 32+ hex token is rejected as a tenant filter', () => {
    const parsed = parseOperationListQuery({ tenant: T61_HEX64 });
    expect(parsed.listFilters.tenant).toBeNull();
    // The raw echo still keeps the pasted value - only the sanitized one drops it.
    expect(parsed.tenantFilter).toBe(T61_HEX64);
  });

  test('a solid 32+ hex token is rejected as an id filter', () => {
    expect(parseOperationListQuery({ id: T61_HEX64 }).listFilters.idContains).toBeNull();
  });

  test('a hostile tenant token is rejected by the sanitized filter', () => {
    const parsed = parseOperationListQuery({ tenant: T61_XSS });
    expect(parsed.listFilters.tenant).toBeNull();
    expect(parsed.tenantFilter).toBe(T61_XSS);
  });

  test('a tenant token containing & or = is rejected outright', () => {
    expect(parseOperationListQuery({ tenant: 'a&b=c' }).listFilters.tenant).toBeNull();
  });

  test('an over-long token is truncated in the raw field and dropped when sanitized', () => {
    const parsed = parseOperationListQuery({ tenant: 't'.repeat(500) });
    expect(parsed.tenantFilter).toHaveLength(128);
    expect(parsed.listFilters.tenant).toBeNull();
  });

  test('a normal tenant token survives the sanitizer', () => {
    expect(parseOperationListQuery({ tenant: 'tenant_a' }).listFilters.tenant).toBe('tenant_a');
  });

  // sort is documented as raw and validated later in the fetcher.
  test('the sort token is a raw passthrough - validation is deferred to the fetcher', () => {
    expect(parseOperationListQuery({ sort: T61_XSS }).sortFilter).toBe(T61_XSS);
  });

  test.each([
    ['', null],
    ['   ', '   '],
    ['c'.repeat(500), 'c'.repeat(128)],
  ])('cursor %p yields %p', (raw, expected) => {
    const parsed = parseOperationListQuery({ cursor: raw });
    if (expected === null) expect(parsed.cursor).toBeNull();
    else expect(parsed.cursor).toBe(expected);
  });

  test('a non-string cursor is null rather than a crash', () => {
    expect(parseOperationListQuery({ cursor: 5 as never }).cursor).toBeNull();
  });

  test('the sanitized filter bag carries exactly three keys', () => {
    expect(Object.keys(parseOperationListQuery({}).listFilters).sort()).toEqual([
      'idContains',
      'state',
      'tenant',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Undefined triage buckets
// ---------------------------------------------------------------------------

describe('W-ADM-UX-17: an absent triage is substituted, a partial one crashes', () => {
  // The asymmetry is the finding: the renderer defends against triage being
  // absent, but not against a triage object that is present and incomplete.
  test('a fully populated triage renders five metrics', () => {
    const html = t61Render(t61Triage());
    expect((html.match(/data-overview-metric=/g) || []).length).toBe(5);
    expect(html).toContain('data-overview-triage="true"');
  });

  test('an entirely absent triage is substituted with the unavailable set', () => {
    const html = t61Render(undefined);
    expect((html.match(/data-overview-metric=/g) || []).length).toBe(5);
    expect(html).toContain('data-overview-triage="true"');
  });

  test('a partial triage with one bucket throws', () => {
    expect(() => t61Render({ failed: { status: 'available', value: 1 } })).toThrow(TypeError);
  });

  test('an empty triage object throws', () => {
    expect(() => t61Render({})).toThrow(TypeError);
  });

  // The value is the count the pane exists to show. A metric marked available
  // with no value still renders as available AND still links out.
  test('an available metric with no value still renders as available and keeps its link', () => {
    const html = t61Render(t61Triage({ failed: { status: 'available' } }));
    expect(html).toContain('data-overview-metric="failed" data-metric-status="available"');
    expect(html).toContain('overview-section__metric-link');
    // Scoped to the failed article: the string 'Unavailable' is legitimately
    // present elsewhere in the panel because connectorDegradations is
    // unavailable by design, so a page-level not.toContain would be vacuous.
    const article = (html.match(/data-overview-metric="failed"[\s\S]*?<\/article>/) || [''])[0];
    expect(article).not.toContain('Unavailable');
  });

  test('a null status renders as an empty status attribute rather than throwing', () => {
    const html = t61Render(t61Triage({ failed: { status: null, value: 1 } }));
    expect(html).toContain('data-overview-metric="failed" data-metric-status=""');
  });
});

// ---------------------------------------------------------------------------
// 3. Malicious diagnostic strings
// ---------------------------------------------------------------------------

describe('W-ADM-UX-17: the metric status lands in a CSS class, and a space splits it', () => {
  // esc() handles quotes and angle brackets, so no raw injection reaches the
  // DOM from the status. But a status containing a SPACE produces two classes
  // in the class attribute, which is a class-name injection of a sort.
  test('a hostile status is escaped, not raw, in both the class and the attribute', () => {
    const html = t61Render(t61Triage({ failed: { status: T61_XSS, value: 1 } }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('a status containing a space splits into an extra CSS class', () => {
    const html = t61Render(t61Triage({ failed: { status: 'a b', value: 1 } }));
    expect(html).toContain('overview-section__metric--a b"');
  });

  test('a hostile diagnostic detail is escaped', () => {
    const html = t61Render(t61Triage({ failed: { status: 'available', value: 1, detail: T61_XSS } }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('a hostile snapshot updatedAt is escaped', () => {
    const html = t61Render(t61Triage({ updatedAt: T61_XSS }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('a diagnostic detail with a quote cannot break out of its tag', () => {
    const html = t61Render(
      t61Triage({ failed: { status: 'available', value: 1, sourceUpdatedAt: '"><script>alert(1)</script>' } }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;');
  });
});

// ---------------------------------------------------------------------------
// 4. Missing aggregate timestamps
// ---------------------------------------------------------------------------

describe('W-ADM-UX-17: a metric without a source timestamp omits the source line', () => {
  test('no sourceUpdatedAt means no Source updated line', () => {
    expect(t61Render(t61Triage())).not.toContain('Source updated');
  });

  test('a sourceUpdatedAt adds the Source updated line', () => {
    const html = t61Render(
      t61Triage({ queueLag: { status: 'stale', value: 3, sourceUpdatedAt: '2026-01-01T00:00:00.000Z' } }),
    );
    expect(html).toContain('Source updated');
    expect(html).toContain('Stale snapshot');
  });

  test('the header still carries an updated-at attribute with no triage at all', () => {
    const html = t61Render(undefined);
    expect(html).toContain('data-overview-updated-at=');
  });

  test('a stale metric keeps both its link and its source line', () => {
    const html = t61Render(
      t61Triage({ failed: { status: 'stale', value: 4, sourceUpdatedAt: '2026-01-01T00:00:00.000Z' } }),
    );
    expect(html).toContain('data-metric-status="stale"');
    expect(html).toContain('Source updated');
    expect(html).toContain('overview-section__metric-link');
  });
});


// ---------------------------------------------------------------------------
// 6. Corrupt filter queries (parseOperationListQuery)
//
// Every value below was measured with a throwaway probe against the real
// parser before being written down. The three constants are imported and also
// asserted, so a change to either the behaviour or the bound shows up here.
// ---------------------------------------------------------------------------

describe('W-ADM-UX-17: the list-limit parser reads a numeric PREFIX out of garbage', () => {
  test('the contract constants are what the tests below assume', () => {
    expect(OPERATION_LIST_DEFAULT_LIMIT).toBe(20);
    expect(OPERATION_LIST_MAX_LIMIT).toBe(100);
    expect(OPERATION_LIST_CURSOR_MAX_LEN).toBe(128);
  });

  // DEFECT: the limit is parsed with parseInt, so a junk suffix is silently
  // discarded and a real number comes out the other end. Pinned so a future
  // switch to Number() with an integer check is a visible diff.
  test('a numeric prefix is accepted: "12abc" becomes 12', () => {
    expect(parseOperationListQuery({ limit: '12abc' }).limit).toBe(12);
  });

  test('hex and exponent forms fall out of a base-10 prefix of 0 or 1', () => {
    // parseInt('0x10', 10) === 0 and parseInt('1e3', 10) === 1, both then
    // clamped up to 1 - so these look like a deliberate page size of 1.
    expect(parseOperationListQuery({ limit: '0x10' }).limit).toBe(1);
    expect(parseOperationListQuery({ limit: '1e3' }).limit).toBe(1);
    expect(parseOperationListQuery({ limit: '1e400' }).limit).toBe(1);
  });

  const clamped: Array<[string, number]> = [
    ['-5', 1],
    ['0', 1],
    ['-0', 1],
    ['-1.9', 1],
    ['1.9', 1],
    ['999', 100],
  ];
  test.each(clamped)('limit %p is clamped to %p', (raw, expected) => {
    expect(parseOperationListQuery({ limit: raw }).limit).toBe(expected);
  });

  test('a fractional limit truncates rather than rounding', () => {
    expect(parseOperationListQuery({ limit: '20.9' }).limit).toBe(20);
  });

  const defaulted: string[] = ['abc', 'Infinity', 'NaN', '', '   '];
  test.each(defaulted)('limit %p falls back to the default 20', (raw) => {
    expect(parseOperationListQuery({ limit: raw }).limit).toBe(20);
  });

  test('surrounding whitespace is trimmed before parsing', () => {
    expect(parseOperationListQuery({ limit: ' 20 ' }).limit).toBe(20);
  });

  test('an over-long numeric string is clamped, not rejected', () => {
    expect(parseOperationListQuery({ limit: '9'.repeat(30) }).limit).toBe(OPERATION_LIST_MAX_LIMIT);
  });

  // The parser assumes Record<string, string> and calls .trim() unguarded.
  test('a non-string limit throws rather than being ignored', () => {
    expect(() => parseOperationListQuery({ limit: 50 as never })).toThrow(TypeError);
  });

  test.each([{}, undefined])('an absent query object still yields a usable default', (query) => {
    const parsed = parseOperationListQuery(query as never);
    expect(parsed.limit).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(parsed.cursor).toBeNull();
    expect(parsed.listFilters.state).toBe('ALL');
  });
});

describe('W-ADM-UX-17: the state filter is the only case-folding field', () => {
  const cases: Array<[string, string, string]> = [
    ['FAILED', 'FAILED', 'FAILED'],
    ['failed', 'failed', 'FAILED'],
    ['  running  ', '  running  ', 'RUNNING'],
    ['BOGUS', 'BOGUS', 'ALL'],
    [T61_XSS, T61_XSS, 'ALL'],
    ['SUCCEEDED;DROP', 'SUCCEEDED;DROP', 'ALL'],
  ];
  test.each(cases)('state %p: raw kept as %p, sanitized to %p', (raw, expectedRaw, expectedList) => {
    const parsed = parseOperationListQuery({ state: raw });
    expect(parsed.stateFilter).toBe(expectedRaw);
    expect(parsed.listFilters.state).toBe(expectedList);
  });

  test.each(['', '   ', undefined])('state %p is dropped from the raw field and reads as ALL', (state) => {
    const parsed = parseOperationListQuery({ state: state as never });
    expect(parsed.stateFilter).toBeUndefined();
    expect(parsed.listFilters.state).toBe('ALL');
  });

  test('a non-string state falls back to ALL without throwing', () => {
    expect(parseOperationListQuery({ state: 5 as never }).listFilters.state).toBe('ALL');
  });
});

describe('W-ADM-UX-17: solid 32+ hex tokens are rejected, 31 characters are not', () => {
  // This is the guard that stops raw API-key material pasted into the toolbar
  // from acting as a search term. The source comments call out that the
  // predicate is the SAME one the list route enforces, so a paste can never be
  // a filter and never comes back echoed. Pinned on both sides of the boundary.
  test('a 64-character hex token is rejected as tenant and as id', () => {
    const hex = 'a'.repeat(64);
    expect(parseOperationListQuery({ tenant: hex }).listFilters.tenant).toBeNull();
    expect(parseOperationListQuery({ id: hex }).listFilters.idContains).toBeNull();
  });

  test('the raw echo still keeps the pasted value - only the sanitized one drops it', () => {
    const hex = 'a'.repeat(64);
    expect(parseOperationListQuery({ tenant: hex }).tenantFilter).toBe(hex);
  });

  test('31 hex characters are ACCEPTED - the guard starts at 32', () => {
    const short = 'a'.repeat(31);
    expect(parseOperationListQuery({ tenant: short }).listFilters.tenant).toBe(short);
  });

  test('a normal tenant token survives the sanitiser', () => {
    expect(parseOperationListQuery({ tenant: 'tenant_a' }).listFilters.tenant).toBe('tenant_a');
  });

  test.each([
    ['tenant', T61_XSS],
    ['id', T61_XSS],
  ])('a hostile %s token is rejected by the sanitiser', (field, value) => {
    expect(parseOperationListQuery({ [field]: value }).listFilters[field === 'id' ? 'idContains' : 'tenant']).toBeNull();
  });

  test('a token containing & or = is rejected outright', () => {
    expect(parseOperationListQuery({ tenant: 'a&b=c' }).listFilters.tenant).toBeNull();
  });

  test('an over-long token is truncated in the raw field and dropped when sanitised', () => {
    const parsed = parseOperationListQuery({ tenant: 't'.repeat(500) });
    expect(parsed.tenantFilter).toHaveLength(OPERATION_LIST_CURSOR_MAX_LEN);
    expect(parsed.listFilters.tenant).toBeNull();
  });

  test('the sanitised filter bag carries exactly three keys', () => {
    expect(Object.keys(parseOperationListQuery({}).listFilters).sort()).toEqual([
      'idContains',
      'state',
      'tenant',
    ]);
  });
});

describe('W-ADM-UX-17: the cursor and sort tokens are raw passthroughs', () => {
  // Both are documented as deferred: the cursor is validated by the fetcher
  // and sort likewise. Pinned so nobody mistakes them for sanitised fields.
  test('an empty cursor is null', () => {
    expect(parseOperationListQuery({ cursor: '' }).cursor).toBeNull();
  });

  test('a non-string cursor is null rather than a crash', () => {
    expect(parseOperationListQuery({ cursor: 5 as never }).cursor).toBeNull();
  });

  test('an over-long cursor is capped at 128 characters', () => {
    expect(parseOperationListQuery({ cursor: 'c'.repeat(3000) }).cursor).toHaveLength(
      OPERATION_LIST_CURSOR_MAX_LEN,
    );
  });

  test('a cursor is returned verbatim, with no character filtering', () => {
    const hostile = '"><script>';
    expect(parseOperationListQuery({ cursor: hostile }).cursor).toBe(hostile);
  });

  test('the sort token is a raw passthrough - validation is deferred to the fetcher', () => {
    expect(parseOperationListQuery({ sort: T61_XSS }).sortFilter).toBe(T61_XSS);
  });
});
