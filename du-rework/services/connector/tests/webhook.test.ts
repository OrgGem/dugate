import { createHmac } from 'node:crypto';
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  webhookSigningPayload,
  type WebhookPayload,
} from '@du/contracts';
import { parseWebhookPayload, verifyWebhookSignature } from '../src';

const secret = new Uint8Array(32).fill(7);

/** Canonical producer format (docs 06): `sha256=<hex>`, as emitted by the Orchestrator's signWebhookBody. */
function sign(timestamp: string, body: string): string {
  const hex = createHmac('sha256', secret).update(webhookSigningPayload(timestamp, body)).digest('hex');
  return `sha256=${hex}`;
}

const payload: WebhookPayload = {
  deliveryId: 'delivery-1',
  eventType: 'operation.succeeded',
  operationId: '11111111-1111-4111-8111-111111111111',
  state: 'SUCCEEDED',
  stateVersion: 3,
  occurredAt: '2099-01-01T00:00:00.000Z',
};

describe('Connector webhook verification (P2-08)', () => {
  test('accepts a correctly signed payload', () => {
    const body = JSON.stringify(payload);
    const timestamp = '1700000000';
    const signature = sign(timestamp, body);
    expect(verifyWebhookSignature(secret, timestamp, body, signature)).toBe(true);
    expect(parseWebhookPayload(JSON.parse(body))).toEqual(payload);
  });

  test('rejects a tampered body', () => {
    const body = JSON.stringify(payload);
    const timestamp = '1700000000';
    const signature = sign(timestamp, body);
    const tampered = JSON.stringify({ ...payload, state: 'FAILED' });
    expect(verifyWebhookSignature(secret, timestamp, tampered, signature)).toBe(false);
  });

  test('rejects a forged signature under a different secret', () => {
    const body = JSON.stringify(payload);
    const timestamp = '1700000000';
    const other = new Uint8Array(32).fill(9);
    const hex = createHmac('sha256', other).update(webhookSigningPayload(timestamp, body)).digest('hex');
    expect(verifyWebhookSignature(secret, timestamp, body, `sha256=${hex}`)).toBe(false);
  });

  test('rejects missing signature or timestamp without throwing', () => {
    const body = JSON.stringify(payload);
    expect(verifyWebhookSignature(secret, undefined, body, 'sig')).toBe(false);
    expect(verifyWebhookSignature(secret, '1700000000', body, undefined)).toBe(false);
  });

  test('parseWebhookPayload rejects a non-strict payload', () => {
    expect(() => parseWebhookPayload({ ...payload, extra: 'field' })).toThrow();
  });

  test('exports the frozen webhook header names', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-du-signature');
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe('x-du-timestamp');
    expect(WEBHOOK_DELIVERY_HEADER).toBe('x-du-delivery-id');
  });
});
