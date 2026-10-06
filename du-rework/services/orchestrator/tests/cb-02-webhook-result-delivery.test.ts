/**
 * CB-02 (PROFILE-CALLBACK-20261006) — result delivery modes & immutable snapshot.
 *
 * Offline by construction: scripted in-file DBs, injected fetch/token servers,
 * no PostgreSQL/Redis/DNS/socket. Two halves:
 *
 *  1. `maybeScheduleWebhook` — mode selection from the admission pin, result
 *     projection + artifact descriptors, bounds, failure/cancel/timeout,
 *     terminal-time freeze, idempotent scheduling.
 *  2. `deliverWebhooks` — result envelope on the wire, byte-identical retries,
 *     CB-03 auth integration (configured headers + OAuth2 401 reacquire),
 *     fail-closed credential paths, redirects disabled.
 */
import { randomUUID } from 'node:crypto';
import {
  CALLBACK_MAX_DELIVERY_BODY_BYTES,
  CallbackResultEnvelopeSchema,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type CallbackResultEnvelope,
  type WebhookPayload,
} from '@du/contracts';
import {
  deliverWebhooks,
  maybeScheduleWebhook,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED,
  type DbClient,
} from '../src/modules/webhooks/webhooks';
import { DEFAULT_CALLBACK_REFERENCE_TTL_MS } from '../src/modules/webhooks/result-projection';

const OPERATION_ID = randomUUID();
const TENANT_ID = randomUUID();
const COMPLETED_AT = '2026-10-06T10:00:00.000Z';
const UPDATED_AT = '2026-10-06T10:00:05.000Z'; // maintenance-ish later write; must NOT win

/* ------------------------------------------------------------------ */
/* Scheduling scripted DB                                              */
/* ------------------------------------------------------------------ */

interface OpSeed {
  state?: string;
  callback_url?: string | null;
  callback_policy?: unknown;
  result_ref?: string | null;
  completed_at?: string | null;
  updated_at?: string;
}

interface ArtifactSeed {
  id: string;
  purpose: string;
  mime_type: string;
  size_bytes: number;
  file_name: string;
  expires_at: string | null;
}

interface SchedulingDb {
  db: { query: DbClient['query']; tx: <T>(fn: (client: DbClient) => Promise<T>) => Promise<T> };
  inserts: Array<{ text: string; params: unknown[] }>;
  updates: Array<{ text: string; params: unknown[] }>;
  scheduledPayload(): unknown;
}

function makeSchedulingDb(
  seed: OpSeed,
  options: {
    artifacts?: ArtifactSeed[];
    artifactsError?: boolean;
    usage?: { count: string; input_tokens: string; output_tokens: string; cost: string; estimated: boolean | null } | 'error';
  } = {},
): SchedulingDb {
  const inserts: Array<{ text: string; params: unknown[] }> = [];
  const updates: Array<{ text: string; params: unknown[] }> = [];
  let inserted = false;
  let payload: unknown;
  const op = {
    id: OPERATION_ID,
    tenant_id: TENANT_ID,
    state: seed.state ?? 'SUCCEEDED',
    state_version: 7,
    callback_url: seed.callback_url === undefined ? 'https://hooks.example.com/cb' : seed.callback_url,
    updated_at: seed.updated_at ?? UPDATED_AT,
    completed_at: seed.completed_at === undefined ? COMPLETED_AT : seed.completed_at,
    callback_policy: seed.callback_policy ?? null,
    result_ref: seed.result_ref ?? 'opaque-result-ref',
  };
  const query: DbClient['query'] = async (text: string, params: unknown[] = []) => {
    const norm = text.replace(/\s+/g, ' ').trim();
    if (norm.startsWith('SELECT id, tenant_id, state, state_version, callback_url')) {
      return { rows: [op], rowCount: 1 };
    }
    if (norm.startsWith('SELECT a.id')) {
      if (options.artifactsError) throw new Error('artifacts projection down');
      return { rows: (options.artifacts ?? []) as unknown as Record<string, unknown>[], rowCount: options.artifacts?.length ?? 0 };
    }
    if (norm.startsWith('SELECT count(*)')) {
      if (options.usage === 'error') throw new Error('usage ledger down');
      return {
        rows: [options.usage ?? { count: '1', input_tokens: '10', output_tokens: '5', cost: '7', estimated: false }],
        rowCount: 1,
      };
    }
    if (norm.startsWith('SELECT result_ref')) {
      return { rows: [{ result_ref: op.result_ref }], rowCount: 1 };
    }
    if (norm.startsWith('INSERT INTO webhook_deliveries')) {
      if (inserted) return { rows: [], rowCount: 0 }; // terminal dedup
      inserted = true;
      inserts.push({ text, params });
      payload = JSON.parse(String(params[6]));
      return { rows: [{ delivery_id: 'delivery-cb02' }], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE webhook_deliveries SET payload')) {
      updates.push({ text, params });
      (payload as Record<string, unknown>).deliveryId = params[1];
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected scheduling SQL: ${norm.slice(0, 90)}`);
  };
  return {
    db: { query, tx: async <T>(fn: (client: DbClient) => Promise<T>) => fn({ query }) },
    inserts,
    updates,
    scheduledPayload: () => payload,
  };
}

const BARE_POLICY = {
  version: 1,
  mode: 'notification_with_result',
  auth: { method: 'none' },
} as const;

const SNAPSHOT_POLICY = {
  tenantId: TENANT_ID,
  businessId: 'document-core',
  businessVersion: '1.0.0',
  profileName: 'invoices',
  endpointKey: 'extract',
  profileRevision: 4,
  policy: BARE_POLICY,
};

function outputArtifact(overrides: Partial<ArtifactSeed> = {}): ArtifactSeed {
  return {
    id: randomUUID(),
    purpose: 'output',
    mime_type: 'application/pdf',
    size_bytes: 2048,
    file_name: 'extract.pdf',
    expires_at: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Dispatcher scripted DB                                              */
/* ------------------------------------------------------------------ */

interface DeliverySeed {
  delivery_id: string;
  tenant_id: string;
  destination_url: string;
  payload: WebhookPayload | CallbackResultEnvelope;
  attempts?: number;
  max_attempts?: number;
  mode?: string;
  callback_policy?: unknown;
}

interface DeliveryDb {
  db: { query: DbClient['query']; tx: <T>(fn: (client: DbClient) => Promise<T>) => Promise<T> };
  row(): { status: string; attempts: number; last_error: string | null; payload: unknown };
}

function makeDeliveryDb(seed: DeliverySeed): DeliveryDb {
  const row = {
    delivery_id: seed.delivery_id,
    tenant_id: seed.tenant_id,
    destination_url: seed.destination_url,
    payload: seed.payload,
    attempts: seed.attempts ?? 0,
    max_attempts: seed.max_attempts ?? 2,
    mode: seed.mode ?? 'notification_only',
    callback_policy: seed.callback_policy ?? null,
    status: 'PENDING',
    last_error: null as string | null,
  };
  let tokenSeq = 0;
  const query: DbClient['query'] = async (text: string, params: unknown[] = []) => {
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
      row.attempts = Number(params[2]);
      row.last_error = String(params[3]);
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
    db: { query, tx: async <T>(fn: (client: DbClient) => Promise<T>) => fn({ query }) },
    row: () => ({ ...row }),
  };
}

function resultEnvelope(occurredAt = COMPLETED_AT): CallbackResultEnvelope {
  return CallbackResultEnvelopeSchema.parse({
    projectionVersion: '1',
    eventType: 'operation.succeeded',
    operationId: OPERATION_ID,
    state: 'SUCCEEDED',
    occurredAt,
    result: { schemaVersion: '1', data: { resultRef: 'opaque-result-ref' }, artifacts: [], warnings: [] },
    artifacts: [],
  });
}

const SECRET = 'whsec-cb02';

/* ------------------------------------------------------------------ */
/* Scheduling: modes, projection, bounds, freeze                       */
/* ------------------------------------------------------------------ */

describe('CB-02 maybeScheduleWebhook — delivery modes & snapshot', () => {
  test('legacy (no pinned policy) stays notification_only and keeps the P2-08 envelope byte-shape', async () => {
    const scripted = makeSchedulingDb({});
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);

    expect(scripted.inserts).toHaveLength(1);
    const params = scripted.inserts[0]!.params;
    expect(params[7]).toBe('notification_only');
    expect(params[8]).toBeNull();
    const payload = scripted.scheduledPayload() as WebhookPayload;
    expect(payload.deliveryId).toBe('delivery-cb02'); // stamped after insert
    expect(payload.occurredAt).toBe(COMPLETED_AT); // terminal fact, not updated_at
    expect(payload.stateVersion).toBe(7);
    expect(scripted.updates).toHaveLength(1); // jsonb_set stamping only in legacy mode
  });

  test('notification_with_result snapshots the result projection, artifacts and usage', async () => {
    const artifact = outputArtifact();
    const scripted = makeSchedulingDb(
      { callback_policy: BARE_POLICY, result_ref: 'opaque-result-ref' },
      {
        artifacts: [
          {
            ...artifact,
            submit_roles: [],
          } as unknown as ArtifactSeed,
        ],
        usage: { count: '2', input_tokens: '12', output_tokens: '4', cost: '9', estimated: false },
      },
    );
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);

    const params = scripted.inserts[0]!.params;
    expect(params[7]).toBe('notification_with_result');
    expect(JSON.parse(String(params[8]))).toEqual(BARE_POLICY);
    expect(scripted.updates).toHaveLength(0); // no deliveryId stamping into a strict envelope

    const envelope = CallbackResultEnvelopeSchema.parse(scripted.scheduledPayload());
    expect(envelope.eventType).toBe('operation.succeeded');
    expect(envelope.occurredAt).toBe(COMPLETED_AT);
    expect(envelope.result).toMatchObject({
      schemaVersion: '1',
      data: { resultRef: 'opaque-result-ref' },
      warnings: [],
    });
    expect(envelope.usage).toEqual({ inputTokens: 12, outputTokens: 4, costMicrousd: 9, measurement: 'measured' });
    expect(envelope.artifacts).toHaveLength(1);
    const descriptor = envelope.artifacts[0]!;
    expect(descriptor.artifactId).toBe(artifact.id);
    expect(descriptor.role).toBe('output');
    expect(descriptor.fileName).toBe('extract.pdf');
    expect(descriptor.download.path).toBe(`/api/v1/artifacts/${artifact.id}/download`);
    expect(descriptor.download.expiresAt).toBe(
      new Date(Date.parse(COMPLETED_AT) + DEFAULT_CALLBACK_REFERENCE_TTL_MS).toISOString(),
    );
  });

  test('the artifact expiry wins over the delivery reference TTL when it is earlier', async () => {
    const expiry = new Date(Date.parse(COMPLETED_AT) + 60_000).toISOString();
    const artifact = outputArtifact({ expires_at: expiry });
    const scripted = makeSchedulingDb(
      { callback_policy: BARE_POLICY },
      { artifacts: [artifact as unknown as ArtifactSeed] },
    );
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    const envelope = CallbackResultEnvelopeSchema.parse(scripted.scheduledPayload());
    expect(envelope.artifacts[0]!.download.expiresAt).toBe(expiry);
  });

  test('a snapshot pin is copied verbatim onto the delivery row (secret refs only)', async () => {
    const scripted = makeSchedulingDb({ callback_policy: SNAPSHOT_POLICY });
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    const params = scripted.inserts[0]!.params;
    expect(JSON.parse(String(params[8]))).toEqual(SNAPSHOT_POLICY);
    expect(String(params[8])).not.toMatch(/secret-value|Bearer [A-Za-z0-9]/);
  });

  test.each([
    ['FAILED', 'operation.failed'],
    ['CANCELLED', 'operation.cancelled'],
    ['TIMED_OUT', 'operation.timed-out'],
  ] as const)('%s snapshots result=null with an explicit UNAVAILABLE reason', async (state, eventType) => {
    const scripted = makeSchedulingDb({ state, callback_policy: BARE_POLICY });
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    const envelope = CallbackResultEnvelopeSchema.parse(scripted.scheduledPayload());
    expect(envelope.eventType).toBe(eventType);
    expect(envelope.state).toBe(state);
    expect(envelope.result).toBeNull();
    expect(envelope.resultOmitted).toBe('UNAVAILABLE');
  });

  test('an oversized inline result is withheld with OVERSIZED and the body stays under the contract bound', async () => {
    const hugeRef = 'R'.repeat(300 * 1024);
    const scripted = makeSchedulingDb({ callback_policy: BARE_POLICY, result_ref: hugeRef });
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    const envelope = CallbackResultEnvelopeSchema.parse(scripted.scheduledPayload());
    expect(envelope.result).toBeNull();
    expect(envelope.resultOmitted).toBe('OVERSIZED');
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(CALLBACK_MAX_DELIVERY_BODY_BYTES);
  });

  test('a sealed result_ref is never projected as content: ENCRYPTED_ONLY', async () => {
    const sealed = JSON.stringify({
      version: 1,
      algorithm: 'aes-256-gcm',
      keyRef: 'du-metadata-v1',
      dek: { version: 1, keyName: 'du-metadata-v1', keyVersion: 1, wrappedKey: 'AAAA' },
      nonce: 'AAAA',
      tag: 'AAAA',
      aad: 'AAAA',
      ciphertext: 'AAAA',
      plaintextSha256: 'a'.repeat(64),
    });
    const scripted = makeSchedulingDb({ callback_policy: BARE_POLICY, result_ref: sealed });
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    const envelope = CallbackResultEnvelopeSchema.parse(scripted.scheduledPayload());
    expect(envelope.result).toBeNull();
    expect(envelope.resultOmitted).toBe('ENCRYPTED_ONLY');
    expect(JSON.stringify(envelope)).not.toContain('ciphertext');
  });

  test('forceReferenceOnly withholds the inline result by policy', async () => {
    const policy = { ...BARE_POLICY, forceReferenceOnly: true };
    const scripted = makeSchedulingDb({ callback_policy: policy });
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    const envelope = CallbackResultEnvelopeSchema.parse(scripted.scheduledPayload());
    expect(envelope.result).toBeNull();
    expect(envelope.resultOmitted).toBe('UNAVAILABLE');
  });

  test('a malformed pin schedules without result projection and preserves the raw pin for the dispatcher', async () => {
    const rawPin = { version: 99, mode: 'surprise' };
    const scripted = makeSchedulingDb({ callback_policy: rawPin });
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    const params = scripted.inserts[0]!.params;
    // No mode can be trusted from an invalid pin, so no result is projected...
    expect(params[7]).toBe('notification_only');
    // ...and the raw pin travels to the dispatcher, which fails the delivery
    // closed instead of sending it unauthenticated (see the dispatcher case).
    expect(JSON.parse(String(params[8]))).toEqual(rawPin);
  });

  test('usage unreadable omits usage but keeps the result; artifacts failure falls back to a valid envelope', async () => {
    const usageDown = makeSchedulingDb({ callback_policy: BARE_POLICY }, { usage: 'error' });
    await maybeScheduleWebhook(usageDown.db, OPERATION_ID);
    const withoutUsage = CallbackResultEnvelopeSchema.parse(usageDown.scheduledPayload());
    expect(withoutUsage.usage).toBeUndefined();
    expect(withoutUsage.result).toMatchObject({ data: { resultRef: 'opaque-result-ref' } });

    const artifactsDown = makeSchedulingDb({ callback_policy: BARE_POLICY }, { artifactsError: true });
    await maybeScheduleWebhook(artifactsDown.db, OPERATION_ID);
    const fallback = CallbackResultEnvelopeSchema.parse(artifactsDown.scheduledPayload());
    expect(fallback.result).toBeNull();
    expect(fallback.resultOmitted).toBe('UNAVAILABLE');
    expect(fallback.artifacts).toEqual([]);
  });

  test('scheduling is idempotent per terminal revision; no callback URL means no row', async () => {
    const scripted = makeSchedulingDb({ callback_policy: BARE_POLICY });
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    expect(scripted.inserts).toHaveLength(1);

    const none = makeSchedulingDb({ callback_url: null, callback_policy: BARE_POLICY });
    await maybeScheduleWebhook(none.db, OPERATION_ID);
    expect(none.inserts).toHaveLength(0);
  });

  test('terminal times are frozen: a later maintenance write to updated_at does not change occurredAt', async () => {
    const scripted = makeSchedulingDb({ callback_policy: BARE_POLICY, updated_at: '2026-10-07T00:00:00.000Z' });
    await maybeScheduleWebhook(scripted.db, OPERATION_ID);
    const envelope = CallbackResultEnvelopeSchema.parse(scripted.scheduledPayload());
    expect(envelope.occurredAt).toBe(COMPLETED_AT);
  });
});

/* ------------------------------------------------------------------ */
/* Dispatcher: wire shape, retries, auth integration                   */
/* ------------------------------------------------------------------ */

describe('CB-02 deliverWebhooks — result mode & auth integration', () => {
  test('notification_with_result is POSTed verbatim with a valid signature and stable deliveryId', async () => {
    const deliveryId = randomUUID();
    const scripted = makeDeliveryDb({
      delivery_id: deliveryId,
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: resultEnvelope(),
      mode: 'notification_with_result',
    });
    const sent: Array<{ url: string; init: Record<string, unknown> }> = [];
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      fetchFn: async (url, init) => {
        sent.push({ url, init: init as unknown as Record<string, unknown> });
        return { status: 200 };
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.init.redirect).toBe('error');
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers[WEBHOOK_DELIVERY_HEADER]).toBe(deliveryId);
    const body = String(sent[0]!.init.body);
    expect(verifyWebhookSignature(SECRET, headers[WEBHOOK_TIMESTAMP_HEADER]!, body, headers[WEBHOOK_SIGNATURE_HEADER]!)).toBe(true);
    expect(CallbackResultEnvelopeSchema.parse(JSON.parse(body)).occurredAt).toBe(COMPLETED_AT);
    expect(scripted.row().status).toBe('DELIVERED');
  });

  test('at-least-once retry replays the byte-identical snapshot: no terminal-time rewrite', async () => {
    const deliveryId = randomUUID();
    const envelope = resultEnvelope();
    const scripted = makeDeliveryDb({
      delivery_id: deliveryId,
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: envelope,
      mode: 'notification_with_result',
    });
    const bodies: string[] = [];
    let outcome = 500;
    const fetchFn = async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return { status: outcome };
    };

    await deliverWebhooks(scripted.db, { secret: SECRET, lookupFn: async () => ['192.0.2.10'], fetchFn });
    expect(scripted.row().status).toBe('PENDING');
    expect(scripted.row().attempts).toBe(1);

    outcome = 200;
    await deliverWebhooks(scripted.db, { secret: SECRET, lookupFn: async () => ['192.0.2.10'], fetchFn });
    expect(scripted.row().status).toBe('DELIVERED');
    expect(scripted.row().attempts).toBe(2);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(CallbackResultEnvelopeSchema.parse(JSON.parse(bodies[1]!)).occurredAt).toBe(COMPLETED_AT);
    // The durable snapshot was not rewritten by either attempt.
    expect(scripted.row().payload).toEqual(envelope);
  });

  test('configured_headers auth attaches the resolved secret header and keeps HMAC headers intact', async () => {
    const policy = {
      version: 1,
      mode: 'notification_with_result',
      auth: {
        method: 'configured_headers',
        headers: [{ name: 'x-api-key', secretRef: { kind: 'managed-secret', ref: 'du/tenants/t/api-key' }, prefix: 'Bearer ' }],
      },
      destination: { approvedOrigins: ['https://hooks.example.com'] },
    };
    const scripted = makeDeliveryDb({
      delivery_id: randomUUID(),
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: resultEnvelope(),
      mode: 'notification_with_result',
      callback_policy: policy,
    });
    const headersSeen: Record<string, string>[] = [];
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      resolveCallbackSecret: async (ref) => (ref === 'du/tenants/t/api-key' ? 'sekret-value' : (() => { throw new Error('unknown ref'); })()),
      fetchFn: async (_url, init) => {
        headersSeen.push(init.headers);
        return { status: 200 };
      },
    });

    expect(scripted.row().status).toBe('DELIVERED');
    expect(headersSeen).toHaveLength(1);
    expect(headersSeen[0]!['x-api-key']).toBe('Bearer sekret-value');
    expect(headersSeen[0]![WEBHOOK_SIGNATURE_HEADER]).toMatch(/^sha256=/);
  });

  test('a credential-bearing policy with no resolver fails closed: nothing is sent unauthenticated', async () => {
    const policy = {
      version: 1,
      mode: 'notification_with_result',
      auth: {
        method: 'configured_headers',
        headers: [{ name: 'x-api-key', secretRef: { kind: 'managed-secret', ref: 'du/tenants/t/token' } }],
      },
      destination: { approvedOrigins: ['https://hooks.example.com'] },
    };
    const scripted = makeDeliveryDb({
      delivery_id: randomUUID(),
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: resultEnvelope(),
      max_attempts: 1,
      callback_policy: policy,
    });
    let calls = 0;
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      fetchFn: async () => {
        calls += 1;
        return { status: 200 };
      },
    });
    expect(calls).toBe(0);
    expect(scripted.row().status).toBe('FAILED');
    // WT-01: the no-resolver case is TERMINAL and now carries its own code, so
    // it is no longer indistinguishable from a transient auth fault. This row is
    // seeded with max_attempts 1, so it reached FAILED before WT-01 too — the
    // behavioural change is the CODE, and the dedicated terminal/attempts
    // contract is pinned in tests/cb03-composition-resolver.test.ts.
    expect(scripted.row().last_error).toBe(WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED);
  });

  test('an unparseable pinned policy fails closed (never replayed as unauthenticated legacy)', async () => {
    const scripted = makeDeliveryDb({
      delivery_id: randomUUID(),
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: resultEnvelope(),
      max_attempts: 1,
      callback_policy: { version: 99, mode: 'surprise' },
    });
    let calls = 0;
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      fetchFn: async () => {
        calls += 1;
        return { status: 200 };
      },
    });
    expect(calls).toBe(0);
    expect(scripted.row().status).toBe('FAILED');
    expect(scripted.row().last_error).toBe('WEBHOOK_POLICY_INVALID');
  });

  test('a destination outside the approved origins never receives credentials or a request', async () => {
    const policy = {
      version: 1,
      mode: 'notification_with_result',
      auth: {
        method: 'configured_headers',
        headers: [{ name: 'x-api-key', secretRef: { kind: 'managed-secret', ref: 'du/tenants/t/api-key' } }],
      },
      destination: { approvedOrigins: ['https://other.example.com'] },
    };
    const scripted = makeDeliveryDb({
      delivery_id: randomUUID(),
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: resultEnvelope(),
      max_attempts: 1,
      callback_policy: policy,
    });
    let calls = 0;
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      resolveCallbackSecret: async () => 'must-not-be-used',
      fetchFn: async () => {
        calls += 1;
        return { status: 200 };
      },
    });
    expect(calls).toBe(0);
    expect(scripted.row().status).toBe('FAILED');
    expect(scripted.row().last_error).toBe('DESTINATION_DENIED');
  });

  test('oauth2_client_credentials: a 401 reacquires once and resends the same body and deliveryId', async () => {
    const policy = {
      version: 1,
      mode: 'notification_with_result',
      auth: {
        method: 'oauth2_client_credentials',
        grantType: 'client_credentials',
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: 'client-1',
        clientSecretRef: { kind: 'managed-secret', ref: 'du/tenants/t/oauth-secret' },
        clientAuthMethod: 'client_secret_post',
        scope: 'callbacks.write',
      },
      destination: { approvedOrigins: ['https://hooks.example.com'] },
    };
    const deliveryId = randomUUID();
    const scripted = makeDeliveryDb({
      delivery_id: deliveryId,
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: resultEnvelope(),
      max_attempts: 2,
      callback_policy: policy,
    });
    let tokenCalls = 0;
    const tokenFetch = async (): Promise<Response> => {
      tokenCalls += 1;
      return new Response(
        JSON.stringify({ access_token: `tok-${tokenCalls}`, token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const deliveries: Array<{ body: string; authorization?: string; deliveryId?: string }> = [];
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      resolveCallbackSecret: async () => 'client-secret-value',
      oauth2Options: { fetchImpl: tokenFetch as unknown as typeof fetch, retryDelayMs: 0 },
      fetchFn: async (_url, init) => {
        deliveries.push({
          body: init.body,
          authorization: init.headers.authorization,
          deliveryId: init.headers[WEBHOOK_DELIVERY_HEADER],
        });
        return { status: deliveries.length === 1 ? 401 : 200 };
      },
    });

    expect(scripted.row().status).toBe('DELIVERED');
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.authorization).toBe('Bearer tok-1');
    expect(deliveries[1]!.authorization).toBe('Bearer tok-2');
    expect(deliveries[0]!.body).toBe(deliveries[1]!.body);
    expect(deliveries[0]!.deliveryId).toBe(deliveryId);
    expect(deliveries[1]!.deliveryId).toBe(deliveryId);
    expect(tokenCalls).toBe(2);
  });

  test('a transport timeout consumes an attempt with a fixed error code and keeps retrying', async () => {
    const scripted = makeDeliveryDb({
      delivery_id: randomUUID(),
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: resultEnvelope(),
      max_attempts: 3,
    });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      fetchFn: async () => {
        throw timeout;
      },
    });
    expect(scripted.row().status).toBe('PENDING');
    expect(scripted.row().attempts).toBe(1);
    // ADM-BASE-03: class-only diagnostic, never the raw transport text.
    expect(scripted.row().last_error).toBe('WEBHOOK_TRANSPORT_FAILED (TimeoutError)');
  });

  test('legacy rows without a pinned policy keep the unauthenticated P2-08 dispatch', async () => {
    const scripted = makeDeliveryDb({
      delivery_id: randomUUID(),
      tenant_id: TENANT_ID,
      destination_url: 'https://hooks.example.com/cb',
      payload: {
        deliveryId: 'legacy',
        eventType: 'operation.succeeded',
        operationId: OPERATION_ID,
        state: 'SUCCEEDED',
        stateVersion: 7,
        occurredAt: COMPLETED_AT,
      } satisfies WebhookPayload,
    });
    const seen: Record<string, string>[] = [];
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      lookupFn: async () => ['192.0.2.10'],
      fetchFn: async (_url, init) => {
        seen.push(init.headers);
        return { status: 200 };
      },
    });
    expect(scripted.row().status).toBe('DELIVERED');
    expect(seen[0]!.authorization).toBeUndefined();
    expect(seen[0]!['x-api-key']).toBeUndefined();
  });
});
