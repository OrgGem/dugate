import {
  UsageEventDrilldownCursorSchema,
  UsageEventDrilldownQuerySchema,
  UsageEventExportPageSchema,
  UsageLedgerEventSchema,
} from '../src';

const EVENT = UsageLedgerEventSchema.parse({
  eventId: 'evt-1',
  idempotencyKey: 'idem-evt-1',
  kind: 'initial',
  tenantId: 'tenant-a',
  apiKeyId: 'key-1',
  operationId: '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45',
  taskId: 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6',
  invocationId: 'inv-1',
  attempt: 1,
  stepKey: 'convert',
  businessId: 'reports',
  businessVersion: 'v1',
  action: 'transform',
  profileRevision: 2,
  connectorId: 'connector-1',
  connectorRevision: 1,
  provider: 'openai',
  model: 'gpt-4o',
  unitType: 'tokens',
  units: { inputTokens: 10, outputTokens: 5 },
  costMicrousd: 25,
  currency: 'USD',
  costStatus: 'measured',
  durationMs: 10,
  occurredAt: '2026-03-01T10:00:00Z',
  receivedAt: '2026-03-01T10:00:05Z',
});

describe('COST-03 paginated usage event query and export contracts', () => {
  test('query defaults to bounded pages and UTC occurredAt ordering', () => {
    expect(UsageEventDrilldownQuerySchema.parse({})).toMatchObject({
      limit: 50,
      timeField: 'occurredAt',
    });
    expect(UsageEventDrilldownQuerySchema.parse({
      tenantId: 'tenant-a',
      apiKeyId: 'key-1',
      businessId: 'reports',
      action: 'transform',
      profileRevision: 2,
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-02T00:00:00Z',
      limit: 100,
    }).limit).toBe(100);
  });

  test('strict allowlist rejects payload content and unsupported filters', () => {
    for (const key of ['prompt', 'document', 'apiKeySecret', 'signedUrl', 'groupBy', 'sort']) {
      expect(() => UsageEventDrilldownQuerySchema.parse({ [key]: 'sensitive' })).toThrow();
    }
  });

  test('page size, query window, paired dimensions, and cursor encoding are bounded', () => {
    expect(() => UsageEventDrilldownQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => UsageEventDrilldownQuerySchema.parse({ limit: 101 })).toThrow();
    expect(() => UsageEventDrilldownQuerySchema.parse({ from: '2026-03-02T00:00:00Z', to: '2026-03-01T00:00:00Z' })).toThrow();
    expect(() => UsageEventDrilldownQuerySchema.parse({ businessId: 'reports' })).toThrow();
    expect(() => UsageEventDrilldownQuerySchema.parse({ provider: 'openai' })).toThrow();
    expect(() => UsageEventDrilldownQuerySchema.parse({ cursor: '$$$' })).toThrow();
    expect(() => UsageEventDrilldownQuerySchema.parse({ cursor: 'a'.repeat(2049) })).toThrow();
  });

  test('cursor payload requires a tenant and query binding plus keyset position', () => {
    const cursor = UsageEventDrilldownCursorSchema.parse({
      version: 1,
      tenantId: 'tenant-a',
      queryHash: 'a'.repeat(64),
      after: '2026-03-01T10:00:00Z',
      eventId: 'evt-1',
    });
    expect(cursor.version).toBe(1);
    expect(() => UsageEventDrilldownCursorSchema.parse({ ...cursor, tenantId: 'bad tenant' })).toThrow();
    expect(() => UsageEventDrilldownCursorSchema.parse({ ...cursor, secret: 'never-export' })).toThrow();
  });

  test('export page is strict, bounded, and requires cursor consistency with hasMore', () => {
    const page = UsageEventExportPageSchema.parse({
      tenantId: 'tenant-a',
      events: [EVENT],
      limit: 2,
      hasMore: false,
      skippedInvalidEvents: 0,
      timeSemantics: { field: 'occurredAt', order: 'asc', timezone: 'UTC' },
    });
    expect(page.events[0]).toStrictEqual(EVENT);
    expect(() => UsageEventExportPageSchema.parse({ ...page, hasMore: true })).toThrow();
    expect(() => UsageEventExportPageSchema.parse({ ...page, rawApiKey: 'secret' })).toThrow();
    expect(() => UsageEventExportPageSchema.parse({
      ...page,
      events: Array.from({ length: 101 }, () => EVENT),
      limit: 100,
    })).toThrow();
    expect(() => UsageEventExportPageSchema.parse({
      ...page,
      events: [{ ...EVENT, prompt: 'private' }],
    })).toThrow();
  });
});
