import type { Db } from '../src/db/db';
import { createCostControlService } from '../src/modules/cost-control/service';
import { handleInternalCostControlRoutes } from '../src/http/routes/internal-cost-control';
import type { RouteContext } from '../src/http/route-context';

const OIDC_ID = '22222222-2222-4222-8222-222222222222';
const LOCAL_ID = '33333333-3333-4333-8333-333333333333';

function createDb(rows: Array<Record<string, unknown>>): Db {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT head_revision,active_revision FROM cost_price_heads')) {
      return { rows: [{ head_revision: 4, active_revision: 4 }], rowCount: 1 };
    }
    if (sql.includes('FROM cost_price_revisions ORDER BY revision DESC')) {
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected SQL in privacy test: ${sql}`);
  });
  return {
    query,
    tx: jest.fn(async (work: (client: never) => Promise<unknown>) => work({} as never)),
    pool: {} as never,
    close: jest.fn(async () => undefined),
  } as unknown as Db;
}

function revision(revision: number, actor: string) {
  return {
    revision,
    state: 'DRAFT',
    tiers: [],
    content_digest: `sha256:${String(revision).padStart(64, '0')}`,
    actor,
    created_at: '2026-10-01T00:00:00.000Z',
    published_at: null,
  };
}

describe('cost policy history actor privacy', () => {
  test('keeps new opaque actor labels and masks legacy OIDC-sub and shell labels, including UUID-shaped subjects', async () => {
    const db = createDb([
      revision(4, `oidc-principal:${OIDC_ID}`),
      revision(3, `local-user:${LOCAL_ID}`),
      revision(2, `session:${OIDC_ID}`),
      revision(1, 'shell:admin'),
    ]);

    const result = await createCostControlService(db).getPrices();

    expect(result.revisions.map((item) => item.actor)).toEqual([
      `oidc-principal:${OIDC_ID}`,
      `local-user:${LOCAL_ID}`,
      'legacy-admin',
      'legacy-admin',
    ]);
    expect(JSON.stringify(result)).not.toContain('session:');
  });

  test('a current verified OIDC Admin mutation uses the opaque directory UUID as its response actor', async () => {
    const rawSubject = 'account@example.invalid';
    const sessionId = 'A'.repeat(43);
    const createPriceDraft = jest.fn(async (_input: unknown, actor: { label: string }) => ({ actor: actor.label }));
    const ctx = {
      ingressAudience: 'internal',
      method: 'POST',
      pathname: '/api/internal/cost-control/prices/draft',
      searchParams: new URLSearchParams(),
      headers: {
        cookie: `du_session=${sessionId}`,
        'x-csrf-token': 'csrf-value',
        'idempotency-key': 'privacy-actor-123',
      },
      body: { expectedHeadRevision: 4, tiers: [] },
      config: {
        adminSessionStore: {
          get: jest.fn(async () => ({
            role: 'admin', tenantId: null, issuer: 'https://idp.example.invalid', sub: rawSubject,
            csrfToken: 'csrf-value', costAlertPrincipalId: OIDC_ID, costAlertAuthorizationVersion: 3,
          })),
        },
      },
      costControl: { createPriceDraft },
    } as unknown as RouteContext;

    const result = await handleInternalCostControlRoutes(ctx);

    expect(result).toEqual({ status: 201, body: { actor: `oidc-principal:${OIDC_ID}` } });
    expect(createPriceDraft).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      label: `oidc-principal:${OIDC_ID}`,
      issuer: 'https://idp.example.invalid',
      sub: rawSubject,
    }), 'privacy-actor-123');
    expect(JSON.stringify(result)).not.toContain(rawSubject);
  });
});
