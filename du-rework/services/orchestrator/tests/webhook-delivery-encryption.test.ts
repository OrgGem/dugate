/**
 * W-ENC-08-WEBHOOK (Delta 110): the webhook dispatcher must obey the SAME per-tenant
 * delivery policy that already governs GET /operations/:id/result and
 * /artifacts/:id/download. Without this, a tenant who switched delivery encryption on
 * would still receive its operation webhooks in the clear.
 *
 * Offline: a scripted db, an injected fetch, and a REAL recipient keypair driving the
 * REAL delivery service, so the envelope is decrypted by what an external recipient
 * would actually do rather than pattern-matched.
 *
 * Pinned here, each for a concrete failure mode:
 *   1. policy ON -> the wire body is the ENC-08 envelope and the recipient recovers
 *      the ORIGINAL payload from it;
 *   2. the HMAC signature covers the ENCRYPTED body. Signing the plaintext and then
 *      swapping the body would leave a signature authenticating bytes the receiver
 *      never received - a silent integrity break, so it is asserted explicitly;
 *   3. policy OFF -> the body is exactly the pre-ENC-07 payload;
 *   4. an unreadable POLICY fails closed: nothing is posted, because a policy we
 *      cannot read is not evidence that the tenant is off;
 *   5. two tenants in one sweep are decided independently, proving the decision is
 *      keyed by the row's tenant rather than a global switch.
 */

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import {
  deliverWebhooks,
  verifyWebhookSignature,
  WEBHOOK_ENCRYPTION_FAILED,
} from '../src/modules/webhooks/webhooks';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER } from '@du/contracts';
import {
  recipientKeyOptions,
  type CryptoConfigAudit,
  type CryptoConfigServiceOptions,
  type CryptoConfigState,
  type CryptoConfigStore,
} from '../src/app/admin/crypto-config-api';
import { createDeliveryEncryptionService } from '../src/modules/public-api';
import type { RecipientPublicKeyRecord } from '../src/modules/encryption/recipient-key-registry';

const TENANT_ON = 'tenant-encrypted';
const TENANT_OFF = 'tenant-plain';
const SECRET = 'webhook-secret';

const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB_PEM = String(kp.publicKey.export({ type: 'spki', format: 'pem' }));
const PRIV_PEM = String(kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));

/** What the external recipient does with an ENC-08 envelope. */
function externalDecrypt(envelope: {
  enc: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}): Buffer {
  const dek = privateDecrypt(
    {
      key: createPrivateKey(PRIV_PEM),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(envelope.enc, 'base64'),
  );
  try {
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.nonce, 'base64'));
    d.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(envelope.ciphertext, 'base64')), d.final()]);
  } finally {
    dek.fill(0);
  }
}

class MemoryStore implements CryptoConfigStore {
  public readonly rows = new Map<string, CryptoConfigState>();
  async get(tenantId: string): Promise<CryptoConfigState> {
    const empty: CryptoConfigState = {
      storageKeyRef: null,
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: null,
    };
    return this.rows.get(tenantId) ?? empty;
  }
  async set(tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState> {
    this.rows.set(tenantId, next);
    return next;
  }
}

class MemoryAudit implements CryptoConfigAudit {
  public readonly rows: unknown[] = [];
  async record(input: unknown): Promise<unknown> {
    this.rows.push(input);
    return { ok: true };
  }
}

function keyRecord(tenantId: string): RecipientPublicKeyRecord {
  return {
    id: 'wh-key-1',
    tenantId,
    version: 1,
    algorithm: 'rsa-oaep-sha256',
    publicKeyPem: PUB_PEM,
    fingerprint: 'SHA256:wh',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
  };
}

/** The real ENC-07 delivery service over a real registry and this keypair. */
function deliveryService(store: MemoryStore) {
  const service: CryptoConfigServiceOptions = {
    allowedKeyRefs: ['primary'],
    store,
    keys: {
      async listRecipientKeys(tenantId: string) {
        return recipientKeyOptions([keyRecord(tenantId)], tenantId);
      },
    },
    audit: new MemoryAudit(),
  };

const registry = {
  async getCurrentKey(tenantId: string) {
    return keyRecord(tenantId);
  },
  async getKeyVersion(tenantId: string, version: number) {
    const base = keyRecord(tenantId);
    return { ...base, version };
  },
};

return createDeliveryEncryptionService({
  policySource: {
    async getDeliveryPolicy(tenantId: string) {
      const state = await store.get(tenantId);
      return {
        enabled: state.deliveryEncryption,
        pinnedRecipientKeyVersion: state.pinnedRecipientKeyVersion,
      };
    },
  },
  recipientKeyRegistry: registry as never,
})!;
}

interface Capture {
  body: string;
  headers: Record<string, string>;
}

interface RowSpec {
  id: string;
  tenant: string;
}

/**
 * Scripted db for the sweep: the claim SELECT, the lease UPDATE and the release
 * UPDATE. Destination adjudication is skipped via allowPrivateNetworks so no DNS is
 * involved; the fetch is injected so the wire body is captured verbatim.
 */
function harness(options: { encrypt: boolean; rows: RowSpec[]; policyFails?: boolean }) {
  const store = new MemoryStore();
  if (options.encrypt) {
    store.rows.set(TENANT_ON, {
      storageKeyRef: 'primary',
      deliveryEncryption: true,
      pinnedRecipientKeyVersion: null,
    });
  }

  const service = deliveryService(store);
  const sent: Capture[] = [];
  const released: Array<{ id: string; lastError: string | null }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/FROM webhook_deliveries/.test(sql)) {
        return {
          rows: options.rows.map((r) => ({
            delivery_id: r.id,
            tenant_id: r.tenant,
            destination_url: 'https://hook.example.test/hook',
            payload: {
              deliveryId: r.id,
              eventType: 'operation.succeeded',
              operationId: 'op-1',
              state: 'SUCCEEDED',
              stateVersion: 3,
              occurredAt: '2026-09-27T00:00:00.000Z',
            },
            attempts: 0,
            max_attempts: 5,
          })),
          rowCount: options.rows.length,
        };
      }

      if (/SET status='DISPATCHING'/.test(sql)) {
        return { rows: [{ next_at: 'lease-' + String(params[0]) }], rowCount: 1 };
      }
      if (/status='DELIVERED'/.test(sql)) {
        released.push({ id: String(params[0]), lastError: null });
        return { rows: [], rowCount: 1 };
      }
      // Both release shapes carry the failure code in $4: the FAILED form is
      // (id, token, attempts, errMsg) and the PENDING backoff form is
      // (id, token, attempts, errMsg, backoffMs).
      if (/status='FAILED'/.test(sql)) {
        released.push({ id: String(params[0]), lastError: String(params[3]) });
        return { rows: [], rowCount: 1 };
      }
      released.push({ id: String(params[0]), lastError: String(params[3]) });
      return { rows: [], rowCount: 1 };
    },
    // The sweep wraps its claim and its release in short transactions; the
    // scripted db has no real one, so tx just runs the callback against itself.
    async tx(fn: (client: unknown) => Promise<never>) {
      return fn(db);
    },
  };
  const encryption = options.policyFails
    ? {
        async resolvePolicy() {
          throw new Error('policy store unavailable');
        },
        async encryptForDelivery() {
          throw new Error('unreachable');
        },
      }
    : service;
  return {
    sent,
    released,
    async run() {
      return deliverWebhooks(db as never, {
        secret: SECRET,
        allowPrivateNetworks: true,
        deliveryEncryption: encryption as never,
        fetchFn: async (url: string, init: { headers: Record<string, string>; body: string }) => {
          sent.push({ body: init.body, headers: init.headers });
          return { status: 200 };
        },
      });
    },
  };
}

const PLAINTEXT_BODY = JSON.stringify({
  deliveryId: 'd1',
  eventType: 'operation.succeeded',
  operationId: 'op-1',
  state: 'SUCCEEDED',
  stateVersion: 3,
  occurredAt: '2026-09-27T00:00:00.000Z',
});

describe('W-ENC-08-WEBHOOK: the dispatcher follows the tenant delivery policy', () => {
  it('policy ON: the wire body is an ENC-08 envelope the recipient can open', async () => {
    const h = harness({ encrypt: true, rows: [{ id: 'd1', tenant: TENANT_ON }] });
    await h.run();

    expect(h.sent).toHaveLength(1);
    const body = JSON.parse(h.sent[0]!.body) as {
      encrypted: boolean;
      delivery: { enc: string; nonce: string; tag: string; ciphertext: string };
    };
    expect(body.encrypted).toBe(true);
    // The plaintext payload is NOT on the wire any more.
    expect(h.sent[0]!.body).not.toContain('operation.succeeded');
    // ...and it really decrypts to the original payload.
    const payload = JSON.parse(externalDecrypt(body.delivery).toString('utf8')) as {
      deliveryId: string;
      operationId: string;
      state: string;
    };
    expect(payload.deliveryId).toBe('d1');
    expect(payload.operationId).toBe('op-1');
    expect(payload.state).toBe('SUCCEEDED');
  });

  it('the HMAC signature covers the ENCRYPTED body, not the plaintext', async () => {
    const h = harness({ encrypt: true, rows: [{ id: 'd1', tenant: TENANT_ON }] });
    await h.run();

    const cap = h.sent[0]!;
    const timestamp = cap.headers[WEBHOOK_TIMESTAMP_HEADER]!;
    const signature = cap.headers[WEBHOOK_SIGNATURE_HEADER]!;
    // Verifies against exactly what went on the wire.
    expect(verifyWebhookSignature(SECRET, timestamp, cap.body, signature)).toBe(true);
    // ...and would NOT verify against the plaintext it encrypts: that ordering
    // is the silent integrity break this asserts against.
    expect(verifyWebhookSignature(SECRET, timestamp, PLAINTEXT_BODY, signature)).toBe(false);
  });

  it('policy OFF: the body is exactly the pre-ENC-07 payload', async () => {
    const h = harness({ encrypt: false, rows: [{ id: 'd1', tenant: TENANT_ON }] });
    await h.run();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.body).toBe(PLAINTEXT_BODY);
  });

  it('an unreadable POLICY fails closed: nothing is posted', async () => {
    // Not evidence the tenant is off. A policy we cannot read must never
    // become permission to send the payload in the clear.
    const h = harness({ encrypt: true, rows: [{ id: 'd1', tenant: TENANT_ON }], policyFails: true });
    await h.run();

    expect(h.sent).toHaveLength(0);
    expect(h.released[0]?.lastError).toBe(WEBHOOK_ENCRYPTION_FAILED);
  });

  it('two tenants in one sweep are decided independently, not by a global switch', async () => {
    const h = harness({
      encrypt: true,
      rows: [
        { id: 'd-on', tenant: TENANT_ON },
        { id: 'd-off', tenant: TENANT_OFF },
      ],
    });
    await h.run();

    expect(h.sent).toHaveLength(2);
    const encrypted = h.sent.filter((c) => c.body.indexOf('"encrypted"') !== -1);
    const plain = h.sent.filter((c) => c.body.indexOf('"encrypted"') === -1);
    expect(encrypted).toHaveLength(1);
    expect(plain).toHaveLength(1);
    expect(JSON.parse(plain[0]!.body).deliveryId).toBe('d-off');
  });
});
