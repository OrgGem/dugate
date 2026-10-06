#!/usr/bin/env node
/**
 * LIVE-GATES webhook step — runs INSIDE the candidate orchestrator container.
 *
 * Mounted read-only by `compose/live-gates.override.yml`; executed by
 * `webhook-live-idp.cjs --mode live --run-live` via `docker compose exec`.
 * It uses the IMAGE's own compiled code (`/app/dist/...`) and the same
 * `deliverWebhooks` production dispatcher path, against the harness HTTPS
 * IdP/receiver, then prints a single JSON receipt line.
 *
 * It never modifies product code; it only inserts one synthetic
 * `webhook_deliveries` row referencing an existing terminal operation (the
 * scheduling side `operations -> webhook_deliveries` is exercised by the
 * E2E/Portal gates separately).
 *
 * Env (all supplied by the harness):
 *   LIVE_RECEIVER_URL, LIVE_IDP_URL, LIVE_WEBHOOK_SECRET, LIVE_CLIENT_ID,
 *   LIVE_CLIENT_SECRET, LIVE_OPERATION_ID (optional), DATABASE_URL (compose).
 *
 * Exit: 0 delivered, 1 not delivered, 2 config/prereq.
 */
'use strict';

const { createDb } = require('/app/dist/db/db.js');
const webhooks = require('/app/dist/modules/webhooks/webhooks.js');

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    process.stderr.write(`missing env ${name}\n`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const receiverUrl = requiredEnv('LIVE_RECEIVER_URL');
  const idpUrl = requiredEnv('LIVE_IDP_URL');
  const webhookSecret = requiredEnv('LIVE_WEBHOOK_SECRET');
  const clientId = process.env.LIVE_CLIENT_ID ?? 'live-gates-client';
  const clientSecret = requiredEnv('LIVE_CLIENT_SECRET');
  const operationId = process.env.LIVE_OPERATION_ID;

  const db = createDb(requiredEnv('DATABASE_URL'));
  try {
    const op = operationId
      ? (await db.query(
          `SELECT id, tenant_id, state_version, state FROM operations WHERE id=$1`,
          [operationId],
        )).rows[0]
      : (await db.query(
          `SELECT id, tenant_id, state_version, state FROM operations
            WHERE state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
            ORDER BY created_at DESC LIMIT 1`,
        )).rows[0];
    if (!op) {
      process.stderr.write(JSON.stringify({
        error: 'NO_TERMINAL_OPERATION',
        hint: 'run any live E2E (e.g. ingest) first, or pass LIVE_OPERATION_ID',
      }) + '\n');
      process.exit(2);
    }

    const destinationOrigin = new URL(receiverUrl).origin;
    const callbackPolicy = {
      version: 1,
      mode: 'notification_only',
      auth: {
        method: 'oauth2_client_credentials',
        grantType: 'client_credentials',
        tokenUrl: idpUrl,
        clientId,
        clientSecretRef: { kind: 'managed-secret', ref: 'live-gates/client' },
        clientAuthMethod: 'client_secret_post',
      },
      destination: { approvedOrigins: [destinationOrigin] },
    };
    const payload = {
      deliveryId: '',
      eventType: 'operation.succeeded',
      operationId: op.id,
      state: 'SUCCEEDED',
      stateVersion: op.state_version,
      occurredAt: new Date().toISOString(),
    };
    const inserted = await db.query(
      `INSERT INTO webhook_deliveries
         (operation_id, tenant_id, event_type, terminal_state, state_version,
          destination_url, payload, mode, callback_policy, max_attempts)
       VALUES ($1,$2,'operation.succeeded','SUCCEEDED',$3,$4,$5,'notification_only',$6,1)
       RETURNING delivery_id`,
      [op.id, op.tenant_id, op.state_version, receiverUrl, JSON.stringify(payload), JSON.stringify(callbackPolicy)],
    );
    const deliveryId = inserted.rows[0].delivery_id;
    await db.query(
      `UPDATE webhook_deliveries SET payload = jsonb_set(payload, '{deliveryId}', to_jsonb($2::text))
        WHERE delivery_id=$1`,
      [deliveryId, deliveryId],
    );

    const claimed = await webhooks.deliverWebhooks(db, {
      secret: webhookSecret,
      // Harness-only opt-in: the receiver is a loopback-side fixture. The
      // SSRF fence for real destinations is covered by the unit matrices and
      // is not weakened in product code.
      allowPrivateNetworks: true,
      // SC-01 catalog is descoped for r4.1; the harness supplies the exact
      // reference value for this synthetic run (reviewer §11.2).
      resolveCallbackSecret: async () => clientSecret,
    });

    const row = (await db.query(
      `SELECT status, attempts, last_error, delivered_at FROM webhook_deliveries WHERE delivery_id=$1`,
      [deliveryId],
    )).rows[0];
    process.stdout.write(JSON.stringify({
      deliveryId,
      operationId: op.id,
      claimed,
      receipt: {
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
        deliveredAt: row.delivered_at,
      },
    }) + '\n');
    process.exit(row.status === 'DELIVERED' ? 0 : 1);
  } finally {
    await db.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`inside dispatcher failed: ${error && error.message ? error.message : error}\n`);
  process.exit(1);
});
