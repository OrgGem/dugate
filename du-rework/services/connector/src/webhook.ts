import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WebhookPayloadSchema,
  webhookSigningPayload,
  type WebhookPayload,
} from '@du/contracts';

/**
 * Webhook adoption (P2-08). The Orchestrator's operation webhook path (later wave)
 * signs each delivery with HMAC-SHA256 over `{timestamp}.{body}` and sends the
 * signature/timestamp/delivery-id in dedicated headers. This module adopts the
 * frozen `@du/contracts` surface so the Connector can verify and parse those
 * deliveries. No Connector-side webhook delivery endpoint is added yet.
 */

export interface WebhookHeaders {
  [WEBHOOK_SIGNATURE_HEADER]: string | undefined;
  [WEBHOOK_TIMESTAMP_HEADER]: string | undefined;
  [WEBHOOK_DELIVERY_HEADER]: string | undefined;
}

/**
 * Constant-time HMAC-SHA256 verification over `{timestamp}.{body}`. Accepts the
 * canonical producer wire format `sha256=<hex>` (docs 06; the Orchestrator's
 * `signWebhookBody` emits exactly this into `x-du-signature`). Returns false
 * for any missing/invalid signature or timestamp; never throws on bad input.
 */
export function verifyWebhookSignature(
  secret: string | Uint8Array,
  timestamp: string | undefined,
  body: string,
  signature: string | undefined,
): boolean {
  if (!timestamp || !signature) return false;
  const expected = createHmac('sha256', secret)
    .update(webhookSigningPayload(timestamp, body))
    .digest();
  const hex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  let provided: Buffer;
  try {
    provided = Buffer.from(hex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Parse and validate a strict webhook payload. Throws on schema violation. */
export function parseWebhookPayload(body: unknown): WebhookPayload {
  return WebhookPayloadSchema.parse(body);
}

export { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_DELIVERY_HEADER };
