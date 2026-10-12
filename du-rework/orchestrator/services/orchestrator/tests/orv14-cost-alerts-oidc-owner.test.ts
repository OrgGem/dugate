import type { QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import {
  costAlertOidcRecipientDto,
  ensureSelfRecipient,
  observeVerifiedLogin,
  resolveCurrentPrincipal,
  type TrustedCostAlertOidcSession,
} from '../src/modules/cost-alerts/oidc-recipients';

const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
const ISSUER = 'https://login.example.test';
const SUBJECT = 'person-opaque-subject-7';

type DirectoryRow = Record<string, unknown>;

function row(overrides: DirectoryRow = {}): DirectoryRow {
  return {
    principal_id: PRINCIPAL,
    display_code: 'AB12CD34EF',
    issuer: ISSUER,
    subject: SUBJECT,
    observed_role: 'admin',
    observed_tenant_id: null,
    state: 'ENABLED',
    authorization_version: 1,
    last_verified_at: '2026-10-11T20:00:00.000Z',
    ...overrides,
  };
}

function fakeDb(handler: (sql: string, params: unknown[]) => DirectoryRow[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rows = handler(sql, params);
    return { rows: rows as QueryResultRow[], rowCount: rows.length };
  };
  const client = { query };
  const db = {
    query,
    async tx<T>(run: (value: never) => Promise<T>): Promise<T> { return run(client as never); },
  };
  return { db: db as unknown as Db, calls };
}

describe('ORV14 external cost-alert recipient owner checks', () => {
  test('creates an opaque recipient from verified Admin facts and keeps IdP identity out of browser DTOs', async () => {
    const fake = fakeDb((sql, params) => {
      if (sql.includes('INSERT INTO cost_alert_oidc_recipients')) {
        return [row({
          principal_id: params[0], display_code: params[1], issuer: params[2], subject: params[3],
          observed_role: params[4], observed_tenant_id: params[5], last_verified_at: params[6],
        })];
      }
      return [];
    });
    const observed = await observeVerifiedLogin(fake.db, {
      issuer: ISSUER, sub: SUBJECT, role: 'admin', tenantId: null, verifiedAt: '2026-10-11T21:00:00.000Z',
    });

    expect(observed?.sessionEligible).toBe(true);
    expect(observed?.principal.principalId).toMatch(/^[0-9a-f-]{36}$/i);
    const dto = costAlertOidcRecipientDto(observed!.principal);
    expect(dto).toMatchObject({ kind: 'oidc', role: 'ADMIN', state: 'ENABLED', eligible: true });
    expect(JSON.stringify(dto)).not.toContain(ISSUER);
    expect(JSON.stringify(dto)).not.toContain(SUBJECT);
  });

  test('rejects an older verified role observation without changing the current directory row', async () => {
    const fake = fakeDb((sql) => sql.includes('FROM cost_alert_oidc_recipients WHERE issuer=$1') ? [row()] : []);
    const observed = await observeVerifiedLogin(fake.db, {
      issuer: ISSUER, sub: SUBJECT, role: 'operator', tenantId: null, verifiedAt: '2026-10-11T19:59:59.000Z',
    });

    expect(observed?.sessionEligible).toBe(false);
    expect(observed?.principal.authorizationVersion).toBe(1);
    expect(fake.calls.some((call) => call.sql.startsWith('UPDATE cost_alert_oidc_recipients'))).toBe(false);
  });

  test('a later role downgrade advances the pin and cannot re-enable a revoked recipient', async () => {
    const current = row({ state: 'REVOKED', authorization_version: 3 });
    const fake = fakeDb((sql, params) => {
      if (sql.includes('FROM cost_alert_oidc_recipients WHERE issuer=$1')) return [current];
      if (sql.startsWith('UPDATE cost_alert_oidc_recipients')) {
        return [row({
          observed_role: params[1], observed_tenant_id: params[2], authorization_version: params[3],
          last_verified_at: params[4], state: 'REVOKED',
        })];
      }
      return [];
    });
    const observed = await observeVerifiedLogin(fake.db, {
      issuer: ISSUER, sub: SUBJECT, role: 'operator', tenantId: null, verifiedAt: '2026-10-11T21:00:00.000Z',
    });

    expect(observed?.sessionEligible).toBe(false);
    expect(observed?.principal).toMatchObject({ state: 'REVOKED', role: 'operator', authorizationVersion: 4 });
    const update = fake.calls.find((call) => call.sql.startsWith('UPDATE cost_alert_oidc_recipients'));
    expect(update?.sql).not.toMatch(/SET[^]*state\s*=/i);
  });

  test('requires the server-pinned current principal for inbox use and refuses an unpinned existing identity', async () => {
    const enabled = row({ authorization_version: 2 });
    const matchingSession: TrustedCostAlertOidcSession = {
      issuer: ISSUER, sub: SUBJECT, role: 'admin', tenantId: null,
      costAlertPrincipalId: PRINCIPAL, costAlertAuthorizationVersion: 2, createdAt: Date.parse('2026-10-11T19:00:00.000Z'),
    };
    const fake = fakeDb((sql) => sql.includes('FROM cost_alert_oidc_recipients WHERE principal_id=$1')
      || sql.includes('FROM cost_alert_oidc_recipients WHERE issuer=$1') ? [enabled] : []);
    expect(await resolveCurrentPrincipal(fake.db, matchingSession)).toMatchObject({ principalId: PRINCIPAL, eligible: true });
    await expect(ensureSelfRecipient(fake.db, { ...matchingSession, costAlertPrincipalId: undefined, costAlertAuthorizationVersion: undefined }))
      .rejects.toMatchObject({ status: 403, code: 'COST_ALERT_RECIPIENT_UNAVAILABLE' });

    const disabled = fakeDb((sql) => sql.includes('FROM cost_alert_oidc_recipients WHERE principal_id=$1')
      ? [row({ state: 'DISABLED', authorization_version: 3 })] : []);
    expect(await resolveCurrentPrincipal(disabled.db, matchingSession)).toBeNull();
  });
});
