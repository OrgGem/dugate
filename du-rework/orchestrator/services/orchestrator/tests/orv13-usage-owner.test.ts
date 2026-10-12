import {
  buildUsageEventQuery,
  buildUsageEventsCsv,
  parseAdminUsageEventPage,
  parseUsageSummary,
  usageFiltersFromSearch,
  usageFiltersToSearch,
  usageRequestIsCurrent,
  validateUsageFilters,
  type AdminUsageEventView,
  type UsageFilters,
} from '../../../apps/admin-web/src/features/usage/state';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const OPERATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const EVENT = {
  eventId: 'usage-event-1',
  operationId: OPERATION_A,
  taskId: 'task-1',
  invocationId: 'invoke-1',
  provider: null,
  model: null,
  units: { inputTokens: 10, outputTokens: 2, pages: 1 },
  costMicrousd: null,
  costStatus: null,
  measurement: 'measured',
  occurredAt: '2026-10-10T10:00:00.000Z',
  receivedAt: '2026-10-10T10:00:03.000Z',
};

const PAGE = {
  tenantId: TENANT_A,
  events: [EVENT],
  limit: 25,
  hasMore: false,
  skippedInvalidEvents: 0,
  timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' },
};

describe('UI13 usage and cost projection', () => {
  test('summary parser preserves explicit cost states and rejects unsafe numeric totals', () => {
    const summary = parseUsageSummary({
      rows: [{ provider: 'provider-x', model: 'model-y', operations: 2, inputTokens: 9, outputTokens: 3, pages: 1, costMicrousd: 1200, measurement: 'estimated', costStatus: 'estimated' }],
      totals: { operations: 2, inputTokens: 9, outputTokens: 3, pages: 1, costMicrousd: 1200, costStatus: 'estimated' },
    });
    expect(summary?.rows[0]?.costStatus).toBe('estimated');
    expect(summary?.totals.costStatus).toBe('estimated');
    expect(parseUsageSummary({ rows: [], totals: { operations: 0, inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0, pages: 0, costMicrousd: 0 } })).toBeNull();
  });

  test('basic event page accepts absent attribution and money without fabricating zeros', () => {
    const parsed = parseAdminUsageEventPage(PAGE, TENANT_A);
    expect(parsed?.events[0]).toMatchObject({ provider: null, model: null, costMicrousd: null, costStatus: null });
    expect(parseAdminUsageEventPage(PAGE, '22222222-2222-4222-8222-222222222222')).toBeNull();
    expect(parseAdminUsageEventPage({ ...PAGE, hasMore: true }, TENANT_A)).toBeNull();
    expect(parseAdminUsageEventPage({ ...PAGE, events: [{ ...EVENT, units: { ...EVENT.units, inputTokens: -1 } }] }, TENANT_A)).toBeNull();
  });

  test('ledger query carries the authorized tenant, received-time window and paired provider/model filter', () => {
    const filters: UsageFilters = {
      from: '2026-10-10T00:00',
      to: '2026-10-11T00:00',
      provider: 'provider-x',
      model: 'model-y',
      operationId: OPERATION_A,
      limit: '25',
    };
    expect(validateUsageFilters(filters).error).toBeNull();
    expect(buildUsageEventQuery(TENANT_A, filters, 'opaque-cursor')).toEqual({
      tenantId: TENANT_A,
      from: '2026-10-10T00:00:00.000Z',
      to: '2026-10-11T00:00:00.000Z',
      timeField: 'receivedAt',
      limit: 25,
      cursor: 'opaque-cursor',
      provider: 'provider-x',
      model: 'model-y',
      operationId: OPERATION_A,
    });
    expect(validateUsageFilters({ ...filters, model: '' }).error).toContain('both a provider and model');
    expect(validateUsageFilters({ ...filters, from: '2026-02-30T00:00' }).error).toContain('UTC time bounds');
  });

  test('window and safe local filters round trip through the URL without accepting tenant scope', () => {
    const filters: UsageFilters = {
      from: '2026-10-10T00:00',
      to: '2026-10-11T00:00',
      provider: 'provider-x',
      model: 'model-y',
      operationId: OPERATION_A,
      limit: '100',
    };
    const search = usageFiltersToSearch(filters, '?tenantId=other&view=usage');
    const restored = usageFiltersFromSearch(`?${search}`, Date.parse('2026-10-11T12:00:00Z'));
    expect(restored).toEqual(filters);
    expect(search).not.toContain('tenantId');
    expect(usageFiltersToSearch({ ...filters, provider: 'unsafe value' }, '?tenantId=other&view=usage')).toContain('view=usage');
  });

  test('CSV export is limited to supplied visible rows and neutralizes spreadsheet formulas', () => {
    const rows = [
      { ...EVENT, provider: '=FORMULA', model: 'model-y' },
    ] as AdminUsageEventView[];
    const csv = buildUsageEventsCsv(rows, TENANT_A);
    expect(csv).toContain('"tenant_id","event_id","operation_id"');
    expect(csv).toContain("'=FORMULA");
    expect(csv).toContain('"unknown","USD","measured"');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2);
  });

  test('tenant changes, deselection and a newer refresh fence late responses', () => {
    const oldRequest = { scope: 'tenant-a|window', token: 'tenant-a|window|1' };
    expect(usageRequestIsCurrent(oldRequest.scope, oldRequest.token, 'tenant-b|window', 'tenant-b|window|1')).toBe(false);
    expect(usageRequestIsCurrent(oldRequest.scope, oldRequest.token, null, null)).toBe(false);
    expect(usageRequestIsCurrent(oldRequest.scope, oldRequest.token, oldRequest.scope, 'tenant-a|window|2')).toBe(false);
    expect(usageRequestIsCurrent(oldRequest.scope, oldRequest.token, oldRequest.scope, oldRequest.token)).toBe(true);
  });
});
