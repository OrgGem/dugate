/** Independent verification harness: real dispatcher, scripted SQL/HTTP seams.
 * No sockets, database writes, production credentials or product-source edits.
 */
import { createHash } from 'node:crypto';
import { CallbackResultEnvelopeSchema, WebhookPayloadSchema, WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '@du/contracts';
import { deliverWebhooks, verifyWebhookSignature, type DbClient } from '../src/modules/webhooks/webhooks';

const id = '00000000-0000-4000-8000-000000000001';
const hmac = 'synthetic-vfy-hmac';
const modes = ['notification_only', 'notification_with_result'] as const;
const methods = ['none', 'configured_headers', 'oauth2_client_credentials'] as const;

function fixture(mode: typeof modes[number], method: typeof methods[number]) {
  const payload = mode === 'notification_only'
    ? { deliveryId: id, eventType: 'operation.succeeded', operationId: id, state: 'SUCCEEDED',
        stateVersion: 1, occurredAt: '2026-10-06T00:00:00.000Z' }
    : { projectionVersion: '1', eventType: 'operation.succeeded', operationId: id, state: 'SUCCEEDED',
        occurredAt: '2026-10-06T00:00:00.000Z', result: { answer: 42 }, artifacts: [] };
  const auth = method === 'none' ? { method }
    : method === 'configured_headers'
      ? { method, headers: [{ name: 'x-api-key', secretRef: { kind: 'managed-secret', ref: 'synthetic/key' } }] }
      : { method, grantType: 'client_credentials', tokenUrl: 'https://idp.example.com/token',
          clientId: 'synthetic-client', clientSecretRef: { kind: 'managed-secret', ref: 'synthetic/client' },
          clientAuthMethod: 'client_secret_post' };
  const policy = { version: 1, mode, auth, destination: { approvedOrigins: ['https://receiver.example.com'] } };
  const frozen = JSON.stringify(payload);
  const row = { delivery_id: id, tenant_id: id, destination_url: 'https://receiver.example.com/callback',
    payload, mode, callback_policy: policy, attempts: 0, max_attempts: 3 };
  const receipt = { status: 'PENDING', attempts: 0, lastError: null as string | null };
  const writes: string[] = [];
  const query: DbClient['query'] = async (sql, params = []) => {
    writes.push(sql);
    if (/^\s*SELECT delivery_id/.test(sql)) return { rows: [row], rowCount: 1 };
    if (sql.includes("SET status='DISPATCHING'")) return { rows: [{ next_at: 'fence-1' }], rowCount: 1 };
    if (sql.includes("status='DELIVERED'")) {
      receipt.status = 'DELIVERED'; receipt.attempts += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("status='FAILED'")) {
      receipt.status = 'FAILED'; receipt.attempts = Number(params[2]); receipt.lastError = String(params[3]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET status='PENDING', attempts=")) {
      receipt.status = 'PENDING'; receipt.lastError = String(params[3]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('Unexpected SQL in verification harness');
  };
  return { db: { query, tx: async <T>(fn: (client: DbClient) => Promise<T>) => fn({ query }) }, row, frozen, receipt, writes };
}

describe('VFY-CB-01 mode -> auth -> send -> durable receipt (offline seams)', () => {
  for (const mode of modes) {
    for (const method of methods) {
      test(`${mode} / ${method}: signed body, auth, receipt and immutable snapshot`, async () => {
        const f = fixture(mode, method);
        let tokens = 0;
        let sends = 0;
        const sentHashes: string[] = [];
        const tokenFetch: typeof fetch = async (_url, init) => {
          tokens += 1;
          expect(init?.method).toBe('POST');
          expect(init?.redirect).toBe('error');
          expect(String(init?.body)).toContain('grant_type=client_credentials');
          return new Response(JSON.stringify({ access_token: `synthetic-${tokens}`, token_type: 'Bearer', expires_in: 60 }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        };
        await deliverWebhooks(f.db, {
          secret: hmac, lookupFn: async () => ['192.0.2.10'],
          resolveCallbackSecret: async () => 'synthetic-value', oauth2Options: { fetchImpl: tokenFetch, retryDelayMs: 0 },
          fetchFn: async (_url, init) => {
            sends += 1;
            expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
            expect(init.headers[WEBHOOK_DELIVERY_HEADER]).toBe(id);
            expect(verifyWebhookSignature(hmac, init.headers[WEBHOOK_TIMESTAMP_HEADER]!, init.body,
              init.headers[WEBHOOK_SIGNATURE_HEADER]!)).toBe(true);
            const body: unknown = JSON.parse(init.body);
            expect((mode === 'notification_only' ? WebhookPayloadSchema : CallbackResultEnvelopeSchema).safeParse(body).success).toBe(true);
            expect(init.body).toBe(f.frozen);
            sentHashes.push(createHash('sha256').update(init.body).digest('hex'));
            if (method === 'none') { expect(init.headers.authorization).toBeUndefined(); expect(init.headers['x-api-key']).toBeUndefined(); }
            if (method === 'configured_headers') expect(init.headers['x-api-key']).toBe('synthetic-value');
            if (method === 'oauth2_client_credentials') expect(init.headers.authorization).toBe(`Bearer synthetic-${sends}`);
            return { status: method === 'oauth2_client_credentials' && sends === 1 ? 401 : 204 };
          },
        });
        expect(f.receipt.status).toBe('DELIVERED'); expect(f.receipt.attempts).toBe(1);
        expect(sends).toBe(method === 'oauth2_client_credentials' ? 2 : 1);
        expect(tokens).toBe(method === 'oauth2_client_credentials' ? 2 : 0);
        expect(new Set(sentHashes).size).toBe(1);
        expect(JSON.stringify(f.row.payload)).toBe(f.frozen);
        expect(f.writes.some(sql => /SET\s+payload\s*=/.test(sql))).toBe(false);
      });
    }
    test(`${mode}: missing production resolver fails closed before send`, async () => {
      const f = fixture(mode, 'configured_headers');
      f.row.max_attempts = 1;
      let sends = 0;
      await deliverWebhooks(f.db, { secret: hmac, lookupFn: async () => ['192.0.2.10'],
        fetchFn: async () => { sends += 1; return { status: 200 }; } });
      expect(sends).toBe(0); expect(f.receipt.status).toBe('FAILED');
      // WT-01: a missing resolver is TERMINAL and carries its own code. Before
      // WT-01 this row reported the transient WEBHOOK_AUTH_UNAVAILABLE, which
      // is indistinguishable from a token server outage. max_attempts is 1 here
      // so the row reached FAILED either way; the contract under test is the CODE.
      expect(f.receipt.lastError).toBe('WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED');
      // WT-01: terminal => no retry budget charged.
      expect(f.row.attempts).toBe(0);
    });
  }
});
