/**
 * WT-01 — callback secret resolver composition seam.
 *
 * The defect: ServerConfig declared `resolveCallbackSecret` and create-app
 * forwarded it into the sweep, but nothing in composition assigns it outside
 * tests, so the sweep always got `undefined`. Every credential-bearing pin
 * then failed with WEBHOOK_AUTH_UNAVAILABLE — the TRANSIENT auth code — and
 * burned its retry budget before dying with an error that looked like an
 * upstream incident while the real cause was a missing composition wiring.
 *
 * This file pins both halves of the fix (option b): the seam is real and
 * forwards, and the missing-resolver state is TERMINAL under its own code with
 * the retry budget untouched.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deliverWebhooks,
  WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED,
  WEBHOOK_AUTH_UNAVAILABLE,
} from '../src/modules/webhooks/webhooks';
import { WEBHOOK_SIGNATURE_HEADER } from '@du/contracts';

const SECRET = 'wt01-webhook-secret';
const TENANT_ID = 'tenant-wt01';
const OPERATION_ID = '00000000-0000-4000-8000-00000000wt01';
const COMPLETED_AT = '2026-10-07T00:00:00.000Z';
const DESTINATION = 'https://hooks.example.com/cb';
const APPROVED = 'https://hooks.example.com';

const CREDENTIAL_POLICY = {
  version: 1,
  mode: 'notification_with_result',
  auth: {
    method: 'configured_headers',
    headers: [{ name: 'x-api-key', secretRef: { kind: 'managed-secret', ref: 'du/tenants/t/api-key' } }],
  },
  destination: { approvedOrigins: [APPROVED] },
};

/* ------------------------------------------------------------------ *
 * Composition seam: declared on ServerConfig and forwarded to the sweep
 * ------------------------------------------------------------------ */
describe('WT-01 composition seam', () => {
  const SRC = join(__dirname, '..', 'src');
  const serverTs = readFileSync(join(SRC, 'server.ts'), 'utf8');
  const createAppTs = readFileSync(join(SRC, 'app', 'bootstrap', 'create-app.ts'), 'utf8');
  const mainTs = readFileSync(join(SRC, 'main.ts'), 'utf8');

  it('ServerConfig declares BOTH the resolver and the oauth2 options', () => {
    expect(serverTs).toMatch(/resolveCallbackSecret\??:\s*OutboundSecretResolver/);
    expect(serverTs).toMatch(/callbackOAuth2Options\??:/);
  });

  it('create-app forwards BOTH into the deliverWebhooks sweep options', () => {
    expect(createAppTs).toContain('...(config.resolveCallbackSecret ? { resolveCallbackSecret: config.resolveCallbackSecret } : {}),');
    expect(createAppTs).toContain('...(config.callbackOAuth2Options ? { oauth2Options: config.callbackOAuth2Options } : {}),');
  });

  it('composition does NOT invent a resolver: wiring stays an explicit operator choice', () => {
    // WT-01 is option (b) - the degraded state is published, not silently
    // papered over. A default resolver would be a security decision taken by
    // a reviewer, not the operator.
    expect(mainTs).not.toMatch(/\bresolveCallbackSecret\s*:/);
  });
});

/* ------------------------------------------------------------------ *
 * Delivery: terminal vs transient
 * ------------------------------------------------------------------ */
interface Seed {
  attempts?: number;
  maxAttempts?: number;
}

function makeDeliveryDb(seed: Seed = {}) {
  const row = {
    delivery_id: randomUUID(),
    tenant_id: TENANT_ID,
    destination_url: DESTINATION,
    payload: { schemaVersion: '1', notification: { occurredAt: COMPLETED_AT } },
    attempts: seed.attempts ?? 0,
    max_attempts: seed.maxAttempts ?? 5,
    mode: 'notification_with_result',
    callback_policy: CREDENTIAL_POLICY,
    status: 'PENDING',
    last_error: null as string | null,
  };
  let tokenSeq = 0;
  const query = async (text: string, params: unknown[] = []) => {
    const norm = text.replace(/\s+/g, ' ').trim();
    if (/^SELECT delivery_id/.test(norm)) {
      if (row.status !== 'PENDING' && row.status !== 'DISPATCHING') return { rows: [], rowCount: 0 };
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (/SET status='DISPATCHING'/.test(norm)) {
      row.status = 'DISPATCHING';
      tokenSeq += 1;
      return { rows: [{ next_at: `token-${tokenSeq}` }], rowCount: 1 };
    }
    if (/status='DELIVERED'/.test(norm)) {
      row.status = 'DELIVERED';
      row.attempts += 1;
      row.last_error = null;
      return { rows: [], rowCount: 1 };
    }
    if (/status='FAILED'/.test(norm)) {
      row.status = 'FAILED';
      // params[2] is the NEW attempts value when the caller supplies it (
      // terminal path supplies none), params[3] the error when present.
      if (typeof params[2] === 'number') row.attempts = params[2];
      if (params.length >= 4) row.last_error = String(params[3]);
      else if (params.length === 3) row.last_error = String(params[2]);
      return { rows: [], rowCount: 1 };
    }
    if (/SET status='PENDING', attempts=/.test(norm)) {
      row.status = 'PENDING';
      row.attempts = Number(params[2]);
      row.last_error = String(params[3]);
      return { rows: [], rowCount: 1 };
    }
    if (/SET status='PENDING', last_error=/.test(norm)) {
      row.status = 'PENDING';
      row.last_error = String(params[2]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected delivery SQL: ${norm.slice(0, 90)}`);
  };
  return {
    db: { query, tx: async <T>(fn: (client: typeof query extends never ? never : { query: typeof query }) => Promise<T>) => fn({ query } as never) },
    row: () => ({ ...row }),
  };
}

describe('WT-01 terminal failure when the resolver is not wired', () => {
  it('fails CLOSED, terminal, with NO attempt consumed', async () => {
    const scripted = makeDeliveryDb({ attempts: 0, maxAttempts: 5 });
    let calls = 0;
    await deliverWebhooks(scripted.db as never, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      fetchFn: async () => { calls += 1; return { status: 200 }; },
    });

    const after = scripted.row();
    expect(calls).toBe(0);
    expect(after.status).toBe('FAILED');
    expect(after.last_error).toBe(WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED);
    expect(after.attempts).toBe(0);
  });

  it('does NOT re-open the row on a later sweep (no budget drained across sweeps)', async () => {
    const scripted = makeDeliveryDb({ attempts: 0, maxAttempts: 5 });
    await deliverWebhooks(scripted.db as never, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      fetchFn: async () => { throw new Error('must not be called'); },
    });
    await deliverWebhooks(scripted.db as never, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      fetchFn: async () => { throw new Error('must not be called'); },
    });
    expect(scripted.row().attempts).toBe(0);
    expect(scripted.row().status).toBe('FAILED');
  });

  it('uses a code DISTINCT from the transient WEBHOOK_AUTH_UNAVAILABLE', () => {
    expect(WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED).not.toBe(WEBHOOK_AUTH_UNAVAILABLE);
    expect(WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED).toMatch(/^[A-Z_]+$/);
  });

  it('still delivers normally once a resolver IS supplied (seam is live)', async () => {
    const scripted = makeDeliveryDb({ attempts: 0, maxAttempts: 5 });
    const headersSeen: Record<string, string>[] = [];
    await deliverWebhooks(scripted.db as never, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      resolveCallbackSecret: async (ref) => (ref === 'du/tenants/t/api-key' ? 'sekret-value' : (() => { throw new Error('unknown ref'); })()),
      fetchFn: async (_url, init) => {
        headersSeen.push(init.headers as Record<string, string>);
        return { status: 200 };
      },
    });
    const after = scripted.row();
    expect(after.status).toBe('DELIVERED');
    expect(after.attempts).toBe(1);
    expect(headersSeen).toHaveLength(1);
    // This pin declares no `prefix`, so the resolved secret is sent verbatim —
    // the point is that a WIRED resolver yields a real authenticated header.
    expect(headersSeen[0]!['x-api-key']).toBe('sekret-value');
    expect(headersSeen[0]![WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=/);
  });
});
