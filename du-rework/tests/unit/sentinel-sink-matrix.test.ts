import {
  assertSinksClean,
  buildLogSink,
  buildPgSinks,
  scanTextForSentinels,
  SINK_CATALOG,
  SinkLeakError,
  type SentinelSpec,
  type SinkSource,
} from '../harness/sentinel-scan';

/**
 * CYCLE 138 — offline validation of the SEC-INT-01/G-SEC sentinel sink-scan
 * harness. The scanner must NEVER get a vacuous green: every capability it
 * claims (detect, report-by-id-only, full pg coverage via to_jsonb) gets a
 * positive control with a planted sentinel first.
 */

const SENTINELS: SentinelSpec[] = [
  { id: 'PROVIDER_KEY', value: 'sk-live-CYCLE138sink-0123456789abcdef' },
  { id: 'VAULT_TOKEN', value: 'hvs.CYCLE138sink-f9e8d7c6b5a4' },
  { id: 'IDP_SECRET', value: 'idp-client-secret-CYCLE138sink' },
  { id: 'DSN_PWD', value: 'dsn-pw-CYCLE138sink-9f8e7d' },
];

const sinkWith = (id: string, bodies: string[]): SinkSource => ({ id, read: async () => bodies });

describe('SINK_CATALOG (matrix completeness)', () => {
  it('covers the audited sinks named by the reviewer + prior cycle-99 pair', () => {
    const ids = SINK_CATALOG.map((s) => s.id);
    for (const want of [
      'pg.connector_revisions',
      'pg.connector_invocations',
      'pg.connector_usage_outbox',
      'pg.webhook_deliveries',
      'pg.orchestrator_outbox',
      'http.error_responses',
      'log.structured_buffer',
      'redis.job_payload',
      'pg.admin_audit_events',
      'pg.admin_idempotency',
    ]) {
      expect(ids).toContain(want);
    }
  });
  it('every entry has a medium and a rationale note', () => {
    for (const e of SINK_CATALOG) {
      expect(['pg', 'http', 'log', 'redis', 'html']).toContain(e.medium);
      expect(e.note.length).toBeGreaterThan(20);
    }
  });
});

describe('scanTextForSentinels', () => {
  it('detects planted sentinels and stays silent on clean text', () => {
    expect(scanTextForSentinels(SENTINELS, `row {"h":"${SENTINELS[1]!.value}"}`)).toEqual(['VAULT_TOKEN']);
    expect(scanTextForSentinels(SENTINELS, 'harmless row of ids and counters')).toEqual([]);
  });
  it('ignores empty sentinel values (no match-everything footgun)', () => {
    expect(scanTextForSentinels([{ id: 'BAD', value: '' }], 'anything')).toEqual([]);
  });
});

describe('assertSinksClean', () => {
  it('positive control: a leak in ONE sink among many is caught and reported BY IDS', async () => {
    const sinks = [
      sinkWith('pg.a', ['clean row']),
      sinkWith('pg.connector_revisions', [`{"config":{"headers":{"x-note":"${SENTINELS[0]!.value}"}}}`]),
      sinkWith('http.error_responses', ['{"code":"TEMPORARY_UNAVAILABLE"}']),
    ];
    const err = await assertSinksClean(sinks, SENTINELS).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SinkLeakError);
    const leak = err as SinkLeakError;
    expect(leak.findings).toEqual([{ sinkId: 'pg.connector_revisions', sentinelId: 'PROVIDER_KEY' }]);
  });

  it('the failure message itself NEVER carries the sentinel VALUE (leak-safe reporter)', async () => {
    const sinks = [sinkWith('log.structured_buffer', ['x ' + SENTINELS[2]!.value + ' y'])];
    try {
      await assertSinksClean(sinks, SENTINELS);
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      for (const s of SENTINELS) expect(msg).not.toContain(s.value);
      expect(msg).toContain('log.structured_buffer');
      expect(msg).toContain('IDP_SECRET');
    }
  });

  it('all-clean matrix returns true', async () => {
    const sinks = SINK_CATALOG.map((e) => sinkWith(e.id, ['{"ids":"only","refs":"only"}']));
    await expect(assertSinksClean(sinks, SENTINELS)).resolves.toBe(true);
  });
});

describe('buildPgSinks (live wiring shape)', () => {
  it('one to_jsonb full-row query per pg catalog sink; detects via rows', async () => {
    const executed: string[] = [];
    const fakeQuery = async (sql: string): Promise<unknown[]> => {
      executed.push(sql);
      if (sql.includes('connector_revisions')) {
        return [{ j: `{"credential_source":{"key":"k"},"leak":"${SENTINELS[1]!.value}"}` }];
      }
      return [{ j: '{"ok":1}' }];
    };
    const sinks = buildPgSinks(fakeQuery);
    expect(sinks.map((s) => s.id).sort()).toEqual(
      [
        'pg.admin_audit_events',
        'pg.admin_idempotency',
        'pg.connector_invocations',
        'pg.connector_revisions',
        'pg.connector_usage_outbox',
        'pg.orchestrator_outbox',
        'pg.secret_versions',
        'pg.webhook_deliveries',
      ].sort(),
    );
    const leak = await assertSinksClean(sinks, SENTINELS).then(
      () => null,
      (e: unknown) => e as SinkLeakError,
    );
    expect(leak).not.toBeNull();
    expect(leak!.findings).toEqual([{ sinkId: 'pg.connector_revisions', sentinelId: 'VAULT_TOKEN' }]);
    // full-column coverage: every pg sink query serializes WHOLE rows
    expect(executed.filter((q) => q.includes('to_jsonb'))).toHaveLength(7);
    expect(executed.find((q) => q.includes('secret_versions'))).toContain('encode(encrypted_value');
  });

  it('query failure propagates loudly (a broken scan is NOT a clean scan)', async () => {
    const sinks = buildPgSinks(async () => {
      throw new Error('db unreachable');
    });
    await expect(assertSinksClean(sinks, SENTINELS)).rejects.toThrow(/db unreachable/);
  });
});

describe('buildLogSink', () => {
  it('scans an injected capture buffer (stdout spy / collector tail)', async () => {
    const buffer: string[] = ['line1 hvs.clean', 'line2 ' + SENTINELS[1]!.value];
    const sink = buildLogSink('log.structured_buffer', () => buffer.join('\n'));
    const leak = await assertSinksClean([sink], SENTINELS).then(
      () => null,
      (e: unknown) => e as SinkLeakError,
    );
    expect(leak!.findings).toEqual([{ sinkId: 'log.structured_buffer', sentinelId: 'VAULT_TOKEN' }]);
  });
});
