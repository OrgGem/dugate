import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createPinnedFetch } from '@du/egress';
import {
  CALLBACK_DEFAULT_MODE,
  ProfileCallbackPolicySchema,
  ProfileCallbackPolicySnapshotSchema,
  adjudicateUrlDestination,
  authorizeCallbackDestination,
  isPubliclyRoutableAddress,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSigningPayload,
  type CallbackAuth,
  type CallbackResultEnvelope,
  type DestinationDecision,
  type ProfileCallbackPolicy,
  type ProfileCallbackPolicySnapshot,
  type RecipientDeliveryEnvelope,
  type WebhookEventType,
  type WebhookPayload,
} from '@du/contracts';
import { buildCallbackResultEnvelope } from './result-projection';
import {
  createOutboundAuthSession,
  dispatchWithAuth,
  OutboundAuthError,
  type OutboundAuthPolicy,
  type OutboundAuthSession,
  type OutboundSecretResolver,
} from './outbound-auth';
import type { OAuth2TokenClientOptions } from './oauth2-client';

/**
 * Webhook delivery (P2-08; docs 04 WebhookDelivery + Outbox, docs 06 Webhook).
 *
 * Terminal operation transitions schedule a durable `webhook_deliveries` row
 * in the SAME transaction as the state change, so a crash between commit and
 * dispatch never loses the callback. The background dispatcher POSTs the
 * payload with an HMAC-SHA256 signature and tracks retries
 * (attempts/next_at/status). At-least-once: clients dedup by deliveryId.
 * Delivery failure never changes the operation outcome.
 */

/** Minimal tx client shape shared with runtime/lifecycle (no pg import). */
export interface DbClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

const TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

function eventTypeFor(state: TerminalState): WebhookEventType {
  switch (state) {
    case 'SUCCEEDED':
      return 'operation.succeeded';
    case 'FAILED':
      return 'operation.failed';
    case 'CANCELLED':
      return 'operation.cancelled';
    case 'TIMED_OUT':
      return 'operation.timed-out';
  }
}

/**
 * CB-02: the pinned callback policy of an operation/delivery row. The frozen
 * CB-01 snapshot is preferred (it carries profile/endpoint/revision identity
 * for the OAuth2 cache scope); a bare policy is tolerated.
 *
 * Tri-state on purpose: an ABSENT pin is the legacy notification-only
 * behavior, while an INVALID pin must never be treated as "no auth" — the
 * dispatcher fails such a delivery closed instead of sending it
 * unauthenticated.
 */
type PinnedCallbackPolicyResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'valid';
      readonly policy: ProfileCallbackPolicy;
      /** Exactly what is copied onto the delivery row (snapshot or bare policy). */
      readonly raw: ProfileCallbackPolicy | ProfileCallbackPolicySnapshot;
      readonly profileRevision?: number;
      readonly endpointKey?: string;
    };

function parsePinnedCallbackPolicy(value: unknown): PinnedCallbackPolicyResult {
  if (value === null || value === undefined) return { kind: 'absent' };
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      return { kind: 'invalid' };
    }
  }
  const snapshot = ProfileCallbackPolicySnapshotSchema.safeParse(candidate);
  if (snapshot.success) {
    return {
      kind: 'valid',
      policy: snapshot.data.policy,
      raw: snapshot.data,
      profileRevision: snapshot.data.profileRevision,
      endpointKey: snapshot.data.endpointKey,
    };
  }
  const policy = ProfileCallbackPolicySchema.safeParse(candidate);
  if (policy.success) return { kind: 'valid', policy: policy.data, raw: policy.data };
  return { kind: 'invalid' };
}

/**
 * Schedule a webhook delivery if the operation just reached a terminal state
 * and carries a callback URL. Idempotent: the unique index on
 * (operation_id, state_version, destination_url) + ON CONFLICT DO NOTHING
 * guarantees at-most-one delivery row per terminal revision + destination,
 * even under concurrent schedulers or a replayed terminal transition.
 *
 * MUST be called inside the same transaction as the terminal UPDATE so the
 * row reflects the post-transition state_version (the terminal revision).
 *
 * CB-02: the mode comes from the admission-time `operations.callback_policy`
 * pin. `notification_only` keeps the P2-08 envelope byte-identical;
 * `notification_with_result` snapshots the authorized result projection and
 * artifact descriptors ONCE, here, so retries replay the frozen payload and
 * terminal timestamps can never be rewritten. The policy itself is copied onto
 * the delivery row (secret REFERENCES only) so the dispatcher never re-reads a
 * live profile revision.
 */
export async function maybeScheduleWebhook(client: DbClient, operationId: string): Promise<void> {
  const res = await client.query(
    `SELECT id, tenant_id, state, state_version, callback_url, updated_at, completed_at, callback_policy
     FROM operations WHERE id=$1`,
    [operationId]
  );
  if (!res.rowCount) return;
  const op = res.rows[0] as {
    id: string;
    tenant_id: string;
    state: string;
    state_version: number;
    callback_url: string | null;
    updated_at: string;
    completed_at: string | Date | null;
    callback_policy: unknown;
  };
  if (!op.callback_url) return;
  if (!TERMINAL_STATES.includes(op.state as TerminalState)) return;
  const terminalState = op.state as TerminalState;
  // Terminal fact first: `completed_at` is written by the 0034 trigger at the
  // terminal transition and is immutable afterwards, so a retry can never
  // change the envelope's occurredAt.
  const occurredAt = new Date(op.completed_at ?? op.updated_at).toISOString();
  const pinnedResult = parsePinnedCallbackPolicy(op.callback_policy);
  const pinned = pinnedResult.kind === 'valid' ? pinnedResult : null;
  const mode = pinned?.policy.mode ?? CALLBACK_DEFAULT_MODE;

  let payload: WebhookPayload | CallbackResultEnvelope;
  if (mode === 'notification_with_result') {
    payload = await buildCallbackResultEnvelope(client, {
      operationId: op.id,
      state: terminalState,
      eventType: eventTypeFor(terminalState),
      occurredAt,
      forceReferenceOnly: pinned?.policy.forceReferenceOnly === true,
    });
  } else {
    payload = {
      deliveryId: '', // placeholder replaced by the INSERT RETURNING below
      eventType: eventTypeFor(terminalState),
      operationId: op.id,
      state: terminalState,
      stateVersion: op.state_version,
      occurredAt,
    };
  }

  // Insert first with a generated delivery_id, then stamp the legacy payload
  // with it in the same tx so the delivered body's deliveryId matches the
  // durable row. The result envelope carries no deliveryId field (CB-01
  // strict contract): receivers dedup by the x-du-delivery-id header, which is
  // the same durable row id.
  const inserted = await client.query(
    `INSERT INTO webhook_deliveries
       (operation_id, tenant_id, event_type, terminal_state, state_version, destination_url, payload, mode, callback_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (operation_id, state_version, destination_url) DO NOTHING
     RETURNING delivery_id`,
    [
      op.id,
      op.tenant_id,
      eventTypeFor(terminalState),
      terminalState,
      op.state_version,
      op.callback_url,
      JSON.stringify(payload),
      mode,
      pinnedResult.kind === 'absent'
        ? null
        : JSON.stringify(pinnedResult.kind === 'valid' ? pinnedResult.raw : op.callback_policy),
    ]
  );
  if (!inserted.rowCount) return; // already scheduled for this terminal revision
  const deliveryId = (inserted.rows[0] as { delivery_id: string }).delivery_id;
  if (mode === 'notification_only') {
    await client.query('UPDATE webhook_deliveries SET payload = jsonb_set(payload, \'{deliveryId}\', to_jsonb($2::text)) WHERE delivery_id=$1', [
      deliveryId,
      deliveryId,
    ]);
  }
}

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

/** HMAC-SHA256 over `{timestamp}.{body}` → `sha256=<hex>` (docs 06). */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  const hex = createHmac('sha256', secret).update(webhookSigningPayload(timestamp, body)).digest('hex');
  return `sha256=${hex}`;
}

/** Verify a signature in constant time; returns false on any mismatch. */
export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = signWebhookBody(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  // Constant-time compare without importing node:crypto.timingSafeEqual types.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

export interface WebhookDispatcherOptions {
  /** Tenant/system webhook signing secret. Fail-closed: dispatcher disabled when unset. */
  secret: string;
  /** Injectable fetch (tests substitute a stub; production uses global fetch). */
  fetchFn?: (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal?: AbortSignal;
      /** CB-02: authenticated callback/token requests never follow redirects. */
      redirect?: 'error';
    },
  ) => Promise<{ status: number }>;
  /** Base backoff in ms for attempt n: next_at = now + base * 2^(attempts-1). */
  baseBackoffMs?: number;
  /** Max rows claimed per sweep. */
  batchSize?: number;
  /** Clock override for tests. */
  now?: () => Date;
  /**
   * FIX-CR-02: how long a DISPATCHING claim protects the row before another sweep
   * may re-claim it (crash recovery; at-least-once is the contract). Default 60s.
   */
  claimLeaseMs?: number;
  /**
   * P8-04 GRACEFUL SHUTDOWN: the dispatcher loop passes a shutdown signal. Once it
   * aborts, this sweep (a) stops starting NEW dispatches, (b) lets in-flight HTTP
   * delivery complete within shutdownGraceMs, and (c) releases any not-yet-durable
   * DISPATCHING claims back to PENDING (retry budget untouched) so no row is left
   * hanging. Optional — production wiring in server.ts is the platform lane's step.
   */
  signal?: AbortSignal;
  /** P8-04: how long the sweep waits for in-flight deliveries after shutdown begins. Default 5s. */
  shutdownGraceMs?: number;
  /**
   * R1-C FIX-CR-01: local-test opt-in for EXACT IP-literals only (same semantics as the
   * connector transport). A listed DOMAIN never skips DNS answer adjudication.
   */
  allowHosts?: readonly string[];
  /**
   * Escape hatch for test meshes: skip destination adjudication entirely. NEVER enabled by
   * any production config path; default false (pinned by the boundary suite's bookkeeping/
   * production-default locks).
   */
  allowPrivateNetworks?: boolean;
  /** FIX-CR-02: per-delivery wire deadline (headers AND body) for the production fetch. */
  dispatchTimeoutMs?: number;
  /** Injectable resolver so DNS-path adjudication is testable without the system resolver. */
  lookupFn?: (host: string) => Promise<string[]>;
  /**
   * W-ENC-08-WEBHOOK (Delta 110): per-tenant delivery encryption for webhook
   * bodies. Absent = every webhook is sent as before (plaintext), which is the
   * correct behaviour for a platform with no crypto-config surface. When
   * present, the TENANT's policy decides per delivery - the same policy that
   * governs GET /operations/:id/result and /artifacts/:id/download.
   */
  deliveryEncryption?: WebhookDeliveryEncryption;
  /**
   * CB-02/CB-03: resolves managed secret REFERENCES for a credential-bearing
   * callback policy (`configured_headers`, OAuth2 client secret). Absent = a
   * credential-bearing policy fails closed with `WEBHOOK_AUTH_UNAVAILABLE`;
   * the dispatcher never sends such a callback unauthenticated.
   */
  resolveCallbackSecret?: OutboundSecretResolver;
  /** CB-03 token-client seams (tests inject fetch/clock; production uses defaults). */
  oauth2Options?: OAuth2TokenClientOptions;
}

export interface WebhookDeliveryRow {
  delivery_id: string;
  /**
   * The tenant this delivery belongs to. ENC-07 keys the delivery policy and
   * the recipient key by tenant, so the dispatcher cannot encrypt a webhook
   * without knowing whose policy applies.
   */
  tenant_id: string;
  destination_url: string;
  /**
   * CB-02: the frozen snapshot. `notification_only` rows hold the P2-08
   * `WebhookPayload`; `notification_with_result` rows hold the CB-01
   * `CallbackResultEnvelope`. Retries replay this value verbatim.
   */
  payload: WebhookPayload | CallbackResultEnvelope;
  attempts: number;
  max_attempts: number;
  /** CB-02 mode; absent on pre-0035 rows = legacy notification-only. */
  mode?: string | null;
  /** CB-02 frozen policy snapshot (secret refs only) or bare policy. */
  callback_policy?: unknown;
}

/**
 * W-ENC-08-WEBHOOK (Delta 110): the body that actually goes on the wire.
 *
 * The tenant's OWN policy decides, exactly as it does for GET /result and
 * /download - the dispatcher never chooses a mode. When the policy is on, the
 * payload is encrypted under that tenant's pinned/active recipient key and the
 * same ENC-08 envelope shape is returned, so a recipient decrypts it with the
 * same code path it already uses for the other two surfaces.
 *
 * Throws when the policy is on and encryption cannot be applied. The caller
 * treats that as a FAILED delivery and posts nothing: reading the policy
 * failed is not the same as "policy off", and a policy we could not read must
 * never be treated as permission to send in the clear.
 */
async function buildWebhookBody(
  encryption: WebhookDeliveryEncryption | undefined,
  row: WebhookDeliveryRow,
): Promise<string> {
  const plaintext = JSON.stringify(row.payload);
  if (!encryption) return plaintext;
  const policy = await encryption.resolvePolicy(row.tenant_id);
  if (!policy?.enabled) return plaintext;
  const envelope = await encryption.encryptForDelivery(
    row.tenant_id,
    Buffer.from(plaintext, 'utf8'),
  );
  return JSON.stringify({ schemaVersion: '1', encrypted: true, delivery: envelope });
}

/** Last-error codes written to webhook_deliveries: FIXED strings only — raw error
 * text never enters the column (ADM-BASE-03: last_error is operator-visible via runbook). */
const WEBHOOK_TRANSPORT_FAILED = 'WEBHOOK_TRANSPORT_FAILED';
const WEBHOOK_DESTINATION_UNRESOLVED = 'DESTINATION_UNRESOLVED';
/**
 * P8-04: fixed runbook-visible code for claims the sweep gave back during graceful
 * shutdown WITHOUT consuming a retry attempt (dispatch never completed or never started).
 * Exported so shutdown wiring and operators can grep for exactly this value.
 */
export const WEBHOOK_SHUTDOWN_RELEASED = 'SHUTDOWN_RELEASED';
/**
 * W-ENC-08-WEBHOOK (Delta 110): fixed runbook-visible code for a delivery the
 * dispatcher refused to send because the tenant's delivery encryption is on but
 * could not be applied (no usable recipient key, registry error, crypto failure).
 * The webhook is NOT downgraded to plaintext - that downgrade is the leak this
 * whole feature exists to prevent. The row consumes its retry budget like any
 * other failed delivery, so a fixed key or a restored registry lets the retry win.
 */
export const WEBHOOK_ENCRYPTION_FAILED = 'WEBHOOK_ENCRYPTION_FAILED';
/**
 * CB-02/CB-03: fixed runbook-visible code for a credential-bearing callback
 * that could not be authenticated (no managed-secret resolver wired, or an
 * invalid/expired policy). The delivery fails closed and consumes a retry
 * attempt; it is NEVER sent unauthenticated.
 */
export const WEBHOOK_AUTH_UNAVAILABLE = 'WEBHOOK_AUTH_UNAVAILABLE';
/**
 * CB-02: fixed runbook-visible code for a delivery whose pinned policy cannot
 * be parsed. Such a row is refused (fail closed) instead of being replayed as
 * an unauthenticated legacy notification: an invalid pin must never widen the
 * delivery's security posture.
 */
export const WEBHOOK_POLICY_INVALID = 'WEBHOOK_POLICY_INVALID';

/**
 * CB-02/CB-03: map a frozen CB-01 auth policy onto the CB-03 outbound session
 * policy. Secret VALUES are never resolved here: references are handed to the
 * session, which resolves them per attempt (rotation applies).
 */
function toOutboundAuthPolicy(
  auth: CallbackAuth,
  resolveSecret: OutboundSecretResolver,
): OutboundAuthPolicy {
  switch (auth.method) {
    case 'none':
      return { mode: 'none' };
    case 'configured_headers':
      return {
        mode: 'configured_headers',
        headers: auth.headers.map((header) => ({
          name: header.name,
          secretRef: header.secretRef.ref,
          ...(header.prefix === undefined ? {} : { prefix: header.prefix }),
        })),
      };
    case 'oauth2_client_credentials':
      return {
        mode: 'oauth2_client_credentials',
        config: {
          tokenUrl: auth.tokenUrl,
          clientId: auth.clientId,
          clientSecret: () => resolveSecret(auth.clientSecretRef.ref),
          authMethod: auth.clientAuthMethod,
          ...(auth.scope === undefined ? {} : { scope: auth.scope }),
          ...(auth.audience === undefined ? {} : { audience: auth.audience }),
          ...(auth.resource === undefined ? {} : { resource: auth.resource }),
          ...(auth.extensions === undefined ? {} : { extensionParams: auth.extensions }),
        },
        ...(auth.additionalHeaders === undefined
          ? {}
          : { extraHeaders: auth.additionalHeaders.map((header) => ({ name: header.name, value: header.value })) }),
      };
  }
}

/**
 * The slice of the ENC-07 delivery service this module needs. Declared
 * structurally so webhooks depends on the BEHAVIOUR, not on the public-api
 * module: any object with these two members is accepted, and the production
 * `DeliveryEncryptionService` satisfies it as-is.
 */
export interface WebhookDeliveryEncryption {
  resolvePolicy(tenantId: string): Promise<{ enabled: boolean } | undefined>;
  encryptForDelivery(tenantId: string, payload: Buffer): Promise<RecipientDeliveryEnvelope>;
}

/** Never returns caller-controlled text; class only (errorNameOf pattern in server.ts). */
function errorClassName(err: unknown): string {
  if (err instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(err.name)) return err.name;
  return 'Error';
}

/**
 * FIX-CR-01 destination adjudication before ANY connect. Returns the deny code, or
 * null when the destination may be dispatched. Name resolution failure is NOT a deny
 * (retryable) but a blocked answer IS (the name could point at internal space).
 */
async function adjudicateDestination(
  destinationUrl: string,
  allowHosts: ReadonlySet<string>,
  lookupFn: (host: string) => Promise<string[]>,
  answerCache?: Map<string, string[]>,
): Promise<{ denied: true; code: string } | { denied: false } | { unresolved: true }> {
  let decision: DestinationDecision;
  try {
    decision = adjudicateUrlDestination(destinationUrl, { allowHosts });
  } catch {
    return { denied: true, code: 'DESTINATION_DENIED' };
  }
  if (decision.kind === 'DENIED') return { denied: true, code: 'DESTINATION_DENIED' };
  if (decision.kind === 'NEEDS_RESOLUTION' && decision.host) {
    let answers: string[];
    try {
      answers = await lookupFn(decision.host);
    } catch {
      return { unresolved: true };
    }
    if (!answers.every((address) => isPubliclyRoutableAddress(address))) {
      return { denied: true, code: 'DESTINATION_DENIED' };
    }
    // PR-Q3-09: hand the SAME adjudicated answers to the pinned dispatcher fetch —
    // policy and socket share one resolution per sweep.
    answerCache?.set(decision.host, answers);
  }
  return { denied: false };
}

/**
 * Deliver due pending webhooks (FIX-CR-02: durable claim BEFORE HTTP dispatch).
 *
 * Phase 1 (short tx): SELECT ... FOR UPDATE SKIP LOCKED over due rows — PENDING,
 * or DISPATCHING whose claim lease has EXPIRED (crash recovery) — then flip them
 * to DISPATCHING with a lease and COMMIT. No DB connection or row lock is held
 * during network I/O: a stalled receiver cannot pin the pool or block shutdown.
 * Phase 2 (no tx): per-row destination adjudication (FIX-CR-01: denied rows never
 * reach the network, last_error = DESTINATION_DENIED) and HTTP dispatch.
 * Phase 3 (short tx): release every claim. Final UPDATEs are guarded by
 * status='DISPATCHING' so a claimant whose lease lapsed mid-flight loses the
 * write instead of clobbering the re-claimer's outcome.
 * Success (2xx) → DELIVERED; failure → attempts++ with exponential backoff, or
 * FAILED when the budget is exhausted. Returns the number of rows claimed.
 * At-least-once overall: clients dedup by deliveryId (docs 06).
 */
export async function deliverWebhooks(
  db: { query: DbClient['query']; tx: <T>(fn: (client: DbClient) => Promise<T>) => Promise<T> },
  opts: WebhookDispatcherOptions
): Promise<number> {
  const dispatchTimeoutMs = opts.dispatchTimeoutMs ?? 10_000;
  // PR-Q3-09: per-sweep host->answers cache. adjudicateDestination resolves ONCE per
  // name; the production fetch (pinned, @du/egress) DIALS THAT answer instead of
  // resolving again — closing the DNS-rebinding TOCTOU window on webhook egress too.
  const resolveCache = new Map<string, string[]>();
  const allowHosts = new Set((opts.allowHosts ?? []).map((host) => host.toLowerCase()));
  const lookupFn =
    opts.lookupFn ??
    (async (host) => (await dnsLookup(host, { all: true })).map((entry) => entry.address));
  const pinnedFetch = createPinnedFetch({
    allowHosts,
    allowPrivateNetworks: opts.allowPrivateNetworks,
    resolve: async (host) => {
      const cached = resolveCache.get(host);
      if (cached) return cached;
      const fresh = await lookupFn(host);
      resolveCache.set(host, fresh);
      return fresh;
    },
  });
  const fetchFn =
    opts.fetchFn ??
    (async (url, init) => {
      const res = await pinnedFetch(url, { ...init, signal: AbortSignal.timeout(dispatchTimeoutMs) });
      return { status: res.status };
    });
  const baseBackoff = opts.baseBackoffMs ?? 1000;
  const batchSize = opts.batchSize ?? 25;
  const claimLeaseMs = opts.claimLeaseMs ?? 60_000;
  const now = opts.now ?? (() => new Date());
  const shutdownGraceMs = opts.shutdownGraceMs ?? 5_000;
  // P8-04 (1): shutdown already in progress -> do not claim ANY new deliveries.
  if (opts.signal?.aborted) return 0;

  // FIX-CR-02 phase 1 — short transaction: claim due rows to DISPATCHING with a lease
  // and COMMIT before any network I/O. Stalled receivers can no longer pin a pooled
  // DB connection or row lock for the duration of dispatch.
  const claimResult = await db.tx(async (client) => {
    const res = await client.query(
      `SELECT delivery_id, tenant_id, destination_url, payload, attempts, max_attempts, mode, callback_policy
       FROM webhook_deliveries
       WHERE (status='PENDING' OR (status='DISPATCHING' AND next_at <= now()))
         AND next_at <= now()
       ORDER BY next_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );
    const rows = res.rows as unknown as WebhookDeliveryRow[];
    const tokens = new Map<string, unknown>();
    for (const row of rows) {
      // Cycle-95 ownership fence: RETURNING captures THIS claim's exact lease value as
      // its generation token; a reclaimer writes a DIFFERENT value, so every release below
      // can only land on the caller's own claim. CYCLE-100 LIVE FINDING: next_at must be
      // carried as ::text and compared via $2::timestamptz — the pg wire parses timestamptz
      // into a JS Date that LOSES PostgreSQL's microsecond precision (ms-only), so a Date
      // round-trip silently mismatches and even the RIGHTFUL releaser loses its own fence
      // (witnessed live on real PG 2026-09-25 08:4x; the scripted-db offline twin uses
      // string tokens and cannot see this class of bug).
      const claim = await client.query(
        `UPDATE webhook_deliveries SET status='DISPATCHING',
                next_at = now() + ($2 || ' milliseconds')::interval, updated_at=now()
         WHERE delivery_id=$1
         RETURNING next_at::text AS next_at`,
        [row.delivery_id, String(claimLeaseMs)]
      );
      const token = (claim.rows[0] as { next_at?: unknown } | undefined)?.next_at;
      if (token === undefined) throw new Error('claim lease token missing');
      tokens.set(row.delivery_id, token);
    }
    return { rows, tokens };
  });
  const claimed = claimResult.rows;
  const claimTokens = claimResult.tokens;

  // FIX-CR-02 phase 2 — outside any transaction: adjudicate + dispatch.
  const outcomes: Array<{ row: WebhookDeliveryRow; ok: boolean; errMsg: string | null; shutdownRelease?: boolean }> = [];
  // P8-04 drain bookkeeping. The grace window starts at the abort EVENT, not at the
  // first observed check; setTimeout is unref'd so a never-firing watch cannot keep jest alive.
  let drainDeadlineAt: number | null = null;
  let drainWatch: Promise<'drain-window-elapsed'> | null = null;
  const ensureDrainWatch = (): Promise<'drain-window-elapsed'> | null => {
    if (!opts.signal) return null;
    if (!drainWatch) {
      drainWatch = new Promise<'drain-window-elapsed'>((resolve) => {
        const start = (): void => {
          drainDeadlineAt = Date.now() + shutdownGraceMs;
          const t = setTimeout(() => resolve('drain-window-elapsed'), shutdownGraceMs);
          t.unref?.();
        };
        if (opts.signal!.aborted) start();
        else opts.signal!.addEventListener('abort', start, { once: true });
      });
    }
    return drainWatch;
  };

  {
    for (const row of claimed) {
      let ok = false;
      let errMsg: string | null = null;
      let shutdownRelease = false;
      if (opts.signal?.aborted) {
        // P8-04 (2): shutdown began — never dispatch rows we have not started; give the
        // claim back WITHOUT consuming retry budget (drainDeadline kept from the watch).
        ensureDrainWatch();
        outcomes.push({ row, ok: false, errMsg: WEBHOOK_SHUTDOWN_RELEASED, shutdownRelease: true });
        continue;
      }
      const destination = opts.allowPrivateNetworks
        ? ({ denied: false } as const)
        : await adjudicateDestination(row.destination_url, allowHosts, lookupFn, resolveCache);
      if ('unresolved' in destination) {
        errMsg = WEBHOOK_DESTINATION_UNRESOLVED;
      } else if (destination.denied) {
        // FIX-CR-01: deny before connect — fetchFn is never invoked for blocked targets.
        errMsg = destination.code;
      } else {
        // CB-02/CB-03: a credential-bearing pinned policy must pass the
        // approved-destination check AND have a managed-secret resolver;
        // otherwise the delivery fails closed. It is never sent unauthenticated
        // and never falls back to `none`. Legacy rows (no pinned policy) keep
        // the exact P2-08 path.
        const pinnedResult = parsePinnedCallbackPolicy(row.callback_policy);
        if (pinnedResult.kind === 'invalid') {
          // A non-null pin that does not parse is corruption/tampering, not
          // "no policy": fail closed rather than sending an unauthenticated
          // legacy callback.
          outcomes.push({ row, ok: false, errMsg: WEBHOOK_POLICY_INVALID });
          continue;
        }
        const pinned = pinnedResult.kind === 'valid' ? pinnedResult : null;
        let authSession: OutboundAuthSession | undefined;
        if (pinned && pinned.policy.auth.method !== 'none') {
          const allowed = authorizeCallbackDestination(
            row.destination_url,
            pinned.policy.auth,
            pinned.policy.destination,
          );
          if (allowed.kind === 'DENIED') {
            outcomes.push({ row, ok: false, errMsg: 'DESTINATION_DENIED' });
            continue;
          }
          if (!opts.resolveCallbackSecret) {
            outcomes.push({ row, ok: false, errMsg: WEBHOOK_AUTH_UNAVAILABLE });
            continue;
          }
          try {
            authSession = createOutboundAuthSession(
              toOutboundAuthPolicy(pinned.policy.auth, opts.resolveCallbackSecret),
              {
                resolveSecret: opts.resolveCallbackSecret,
                cacheScope: {
                  tenantId: row.tenant_id,
                  ...(pinned.profileRevision === undefined ? {} : { profileRevision: pinned.profileRevision }),
                  ...(pinned.endpointKey === undefined ? {} : { endpointKey: pinned.endpointKey }),
                },
                ...(opts.oauth2Options === undefined ? {} : { oauth2Options: opts.oauth2Options }),
              },
            );
          } catch {
            outcomes.push({ row, ok: false, errMsg: WEBHOOK_AUTH_UNAVAILABLE });
            continue;
          }
        }
        // ENC-07/Delta 110: build the wire body FIRST, then sign it. Signing the
        // plaintext and then swapping in ciphertext would produce a signature
        // that authenticates bytes the receiver never got - a silent integrity
        // break. A failed encryption posts NOTHING (fail-closed).
        let body: string;
        try {
          body = await buildWebhookBody(opts.deliveryEncryption, row);
        } catch {
          outcomes.push({ row, ok: false, errMsg: WEBHOOK_ENCRYPTION_FAILED });
          continue;
        }
        const timestamp = now().toISOString();
        const signature = signWebhookBody(opts.secret, timestamp, body);
        // CB-03: one send closure reused by the OAuth2 401 reacquire; deliveryId,
        // body and signature stay byte-identical across the retry.
        const send = async (authHeaders: Record<string, string>): Promise<{ status: number }> => {
          const resp = await fetchFn(row.destination_url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [WEBHOOK_SIGNATURE_HEADER]: signature,
              [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
              [WEBHOOK_DELIVERY_HEADER]: row.delivery_id,
              ...authHeaders,
            },
            body,
            redirect: 'error',
          });
          return { status: resp.status };
        };
        const dispatch = (async (): Promise<{ ok: boolean; errMsg: string | null }> => {
          try {
            const result = authSession
              ? await dispatchWithAuth(authSession, send)
              : await send({});
            const good = result.status >= 200 && result.status < 300;
            return { ok: good, errMsg: good ? null : `HTTP ${result.status}` };
          } catch (err) {
            // ADM-BASE-03 / C2-1: last_error is operator-visible (runbook SELECT). Fixed code
            // + error CLASS only — String(err) raw text must never enter the column.
            if (err instanceof OutboundAuthError) {
              return { ok: false, errMsg: `${WEBHOOK_AUTH_UNAVAILABLE} (${err.code})` };
            }
            return { ok: false, errMsg: `${WEBHOOK_TRANSPORT_FAILED} (${errorClassName(err)})` };
          }
        })();
        const watch = ensureDrainWatch();
        if (!watch) {
          const done = await dispatch;
          ok = done.ok;
          errMsg = done.errMsg;
        } else {
          // P8-04 (3): in-flight dispatch may finish within the grace window — that is a
          // REAL delivery and must land normally. Past the window, we give the claim back;
          // a delivery completing later is still at-least-once-consistent (client dedups),
          // and the generation fence (cycle 95) makes its late release lose.
          const raced = await Promise.race([
            dispatch.then((r) => ({ kind: 'done' as const, r })),
            watch.then(() => ({ kind: 'drain' as const })),
          ]);
          if (raced.kind === 'done') {
            ok = raced.r.ok;
            errMsg = raced.r.errMsg;
          } else {
            shutdownRelease = true;
            errMsg = WEBHOOK_SHUTDOWN_RELEASED;
            dispatch.catch(() => undefined); // never reject the sweep's tail
          }
        }
      }
      outcomes.push({ row, ok, errMsg, shutdownRelease });
    }
  }

  // FIX-CR-02 phase 3 — short transaction: release each claim. The
  // status='DISPATCHING' guard makes a stale claimant (lease expired, row
  // re-claimed elsewhere) lose the write instead of clobbering it: last
  // CLAIMED dispatcher wins, delivery stays at-least-once.
  await db.tx(async (client) => {
    for (const { row, ok, errMsg, shutdownRelease } of outcomes) {
      const token = claimTokens.get(row.delivery_id);
      if (token === undefined) continue; // fail-closed: never release a claim we cannot identify
      if (shutdownRelease) {
        // P8-04: give the claim back to the queue. Attempts untouched — no dispatch
        // completed to charge for; next_at=now() makes it immediately due for the next
        // sweep. The own-token guard still applies: if we were re-claimed meanwhile, lose.
        await client.query(
          `UPDATE webhook_deliveries SET status='PENDING', last_error=$3, next_at=now(), updated_at=now()
           WHERE delivery_id=$1 AND status='DISPATCHING' AND next_at=$2::timestamptz`,
          [row.delivery_id, token, WEBHOOK_SHUTDOWN_RELEASED]
        );
        continue;
      }
      if (ok) {
        await client.query(
          `UPDATE webhook_deliveries SET status='DELIVERED', delivered_at=now(), attempts=attempts+1, updated_at=now()
           WHERE delivery_id=$1 AND status='DISPATCHING' AND next_at=$2::timestamptz`,
          [row.delivery_id, token]
        );
      } else {
        const nextAttempts = row.attempts + 1;
        if (nextAttempts >= row.max_attempts) {
          await client.query(
            `UPDATE webhook_deliveries SET status='FAILED', attempts=$3, last_error=$4, updated_at=now()
             WHERE delivery_id=$1 AND status='DISPATCHING' AND next_at=$2::timestamptz`,
            [row.delivery_id, token, nextAttempts, errMsg]
          );
        } else {
          const backoff = baseBackoff * Math.pow(2, row.attempts);
          await client.query(
            `UPDATE webhook_deliveries SET status='PENDING', attempts=$3, last_error=$4,
                    next_at = now() + ($5 || ' milliseconds')::interval, updated_at=now()
             WHERE delivery_id=$1 AND status='DISPATCHING' AND next_at=$2::timestamptz`,
            [row.delivery_id, token, nextAttempts, errMsg, String(backoff)]
          );
        }
      }
    }
  });
  return claimed.length;
}
