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
 * Webhook adoption (P2-08). The Orchestrator's operation webhook path signs each
 * delivery with HMAC-SHA256 over `{timestamp}.{body}` and sends the
 * signature/timestamp/delivery-id in dedicated headers. This module adopts the
 * frozen `@du/contracts` surface so a consumer can verify and parse those
 * deliveries.
 *
 * There is deliberately no inbound webhook route on the Connector. These two
 * functions verify deliveries that the ORCHESTRATOR sends TO an external
 * subscriber; a Connector route would instead mean receiving callbacks FROM a
 * provider, which is a different trust boundary, a different secret, and a
 * different schema. Wiring such a route here without a provider protocol that
 * declares one would be inventing a contract. Consumers that need to verify a
 * webhook call `verifyWebhookSignature` before `parseWebhookPayload`.
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
