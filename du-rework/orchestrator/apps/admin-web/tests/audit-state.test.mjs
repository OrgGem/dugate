import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAuditCsv,
  buildAuditQuery,
  localDateTimeToUtc,
  parseAuditPage,
} from '../src/features/audit/state.ts';

const filters = {
  severity: 'warning',
  action: 'business.enable',
  actor: 'admin',
  resource: 'business:abc',
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-10T12:00:00.000Z',
  sort: 'createdAt:asc',
  limit: '25',
};

describe('audit state helpers', () => {
  it('builds the BFF query with server-side filters, active tenant and keyset cursor', () => {
    assert.deepEqual(buildAuditQuery({ tenantId: 'tenant-a', cursor: 'opaque-next', filters }), {
      tenantId: 'tenant-a',
      limit: '25',
      sort: 'createdAt:asc',
      cursor: 'opaque-next',
      severity: 'warning',
      action: 'business.enable',
      actor: 'admin',
      resource: 'business:abc',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-10T12:00:00.000Z',
    });
  });

  it('omits empty optional filters and does not send ALL as a wire severity', () => {
    const query = buildAuditQuery({
      tenantId: 'tenant-a',
      cursor: null,
      filters: { ...filters, severity: 'ALL', action: ' ', actor: '', resource: '', from: '', to: '' },
    });
    assert.deepEqual(query, { tenantId: 'tenant-a', limit: '25', sort: 'createdAt:asc' });
  });

  it('parses both keyset cursors and the page envelope', () => {
    const page = parseAuditPage({
      items: [{ id: 'event-1', kind: 'business.enable', severity: 'success', occurredAt: '2026-10-10T00:00:00Z', tenantId: 'tenant-a', resourceId: 'business:abc', actor: 'admin', message: 'not projected' }],
      total: 12,
      limit: 25,
      nextCursor: 'next-keyset',
      prevCursor: 'previous-keyset',
    });
    assert.equal(page?.items[0]?.kind, 'business.enable');
    assert.ok(page?.items[0] !== undefined && !('message' in page.items[0]));
    assert.equal(page?.total, 12);
    assert.equal(page?.nextCursor, 'next-keyset');
    assert.equal(page?.prevCursor, 'previous-keyset');
    assert.equal(parseAuditPage({ items: 'invalid' }), null);
  });

  it('converts local date-time inputs to UTC instants', () => {
    assert.equal(localDateTimeToUtc(''), null);
    assert.equal(localDateTimeToUtc('not-a-date'), null);
    const localValue = '2026-10-10T12:00';
    assert.equal(localDateTimeToUtc(localValue), new Date(localValue).toISOString());
    assert.match(localDateTimeToUtc(localValue) ?? '', /Z$/);
  });

  it('exports only allowlisted columns and neutralizes spreadsheet formulas', () => {
    const csv = buildAuditCsv([{
      id: 'event-1',
      occurredAt: '2026-10-10T00:00:00Z',
      severity: 'warning',
      kind: '=HYPERLINK("https://example.invalid")',
      actor: 'ops, "tier 2"',
      resourceId: '@SUM(A1:A2)',
      tenantId: null,
      message: 'must not appear in CSV',
    }], 'tenant-a');

    assert.match(csv, /^"occurred_at","severity","action","actor","resource","tenant_id","event_id"\r\n/);
    assert.ok(csv.includes("'=HYPERLINK("));
    assert.ok(csv.includes('"ops, ""tier 2"""'));
    assert.ok(csv.includes("'@SUM(A1:A2)"));
    assert.ok(csv.includes('"tenant-a"'));
    assert.ok(!csv.includes('must not appear in CSV'));
  });
});
