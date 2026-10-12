import type { PoolClient } from 'pg';
import type { TenantAiTestResult } from '@du/contracts';
import { persistTenantAiTestResult } from '../src/modules/global-settings/service';

const scope = '11111111-1111-4111-8111-111111111111:ai:test';
const key = 'global-ai-test-key-0001';
const requestHash = 'sha256:' + 'a'.repeat(64);

function result(ok: boolean, errorCode: string | null, testedAt: string): TenantAiTestResult {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    revision: 4,
    ok,
    testedAt,
    errorCode,
  };
}

function idempotencyClient(initial: TenantAiTestResult) {
  let stored = initial;
  const updates: unknown[][] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
    if (sql.includes('SELECT request_hash,result FROM global_settings_idempotency')) {
      return { rowCount: 1, rows: [{ request_hash: requestHash, result: stored }] };
    }
    if (sql.startsWith('UPDATE global_settings_idempotency SET result=')) {
      updates.push(params);
      stored = JSON.parse(String(params[2])) as TenantAiTestResult;
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL in idempotency fixture: ${sql}`);
  };
  return { client: { query } as unknown as PoolClient, updates, getStored: () => stored };
}

describe('ORV14 tenant AI test idempotency recovery', () => {
  it('replaces an UNKNOWN result with recovered success for the same request without another insert', async () => {
    const fixture = idempotencyClient(result(false, 'PROVIDER_TEST_UNKNOWN', '2026-10-11T12:00:00.000Z'));
    const recovered = result(true, null, '2026-10-11T12:02:00.000Z');

    const saved = await persistTenantAiTestResult(fixture.client, scope, key, requestHash, recovered);

    expect(saved).toEqual({ result: recovered, changed: true });
    expect(fixture.updates).toHaveLength(1);
    expect(fixture.getStored()).toEqual(recovered);
  });

  it('keeps an unresolved UNKNOWN result stable when Connector evidence is still unavailable', async () => {
    const original = result(false, 'PROVIDER_TEST_UNKNOWN', '2026-10-11T12:00:00.000Z');
    const fixture = idempotencyClient(original);

    const saved = await persistTenantAiTestResult(
      fixture.client,
      scope,
      key,
      requestHash,
      result(false, 'PROVIDER_TEST_UNKNOWN', '2026-10-11T12:03:00.000Z'),
    );

    expect(saved).toEqual({ result: original, changed: false });
    expect(fixture.updates).toHaveLength(0);
  });

  it('does not replace a definitive failure with a later result', async () => {
    const original = result(false, 'PROVIDER_TEST_FAILED', '2026-10-11T12:00:00.000Z');
    const fixture = idempotencyClient(original);

    const saved = await persistTenantAiTestResult(fixture.client, scope, key, requestHash, result(true, null, '2026-10-11T12:03:00.000Z'));

    expect(saved).toEqual({ result: original, changed: false });
    expect(fixture.updates).toHaveLength(0);
  });
});
