/**
 * CB-02 (PROFILE-CALLBACK-20261006) — `notification_with_result` projection.
 *
 * The terminal transition snapshots the callback payload ONCE. This module
 * builds the `CallbackResultEnvelope` (CB-01 frozen contract) from the SAME
 * authorized projection the public `GET /api/v1/operations/:id/result` route
 * exposes:
 *
 *  - `data.resultRef`: the operation's opaque result pointer. Only a legacy
 *    plaintext pointer can be projected here; a sealed envelope
 *    (`metadata-crypto`) is NOT opened (no crypto seam in the scheduling
 *    transaction) and is reported as `resultOmitted: 'ENCRYPTED_ONLY'` —
 *    never copied as ciphertext and never fabricated.
 *  - `artifacts`: authenticated relative download references. NO bytes, NO
 *    storage URLs. `expiresAt` is the artifact's own expiry when the row has
 *    one, otherwise the terminal instant + the delivery reference TTL
 *    (`DEFAULT_CALLBACK_REFERENCE_TTL_MS`, overridable): a reference-validity
 *    advertisement frozen at terminal time. A manual resend replays the stored
 *    snapshot, so it can never extend the advertised expiry.
 *  - `usage`: the same aggregate `usage.project()` reports, when the ledger is
 *    readable; otherwise omitted (never invented).
 *
 * Bounds (CB-01): inline result <= `CALLBACK_MAX_INLINE_RESULT_BYTES`
 * (else `resultOmitted: 'OVERSIZED'`), descriptors <= 32, whole body <=
 * `CALLBACK_MAX_DELIVERY_BODY_BYTES`. Nothing is ever truncated silently: an
 * oversized inline result is withheld WITH an explicit reason, and the
 * descriptor list is trimmed to the body bound only in the (unreachable under
 * bounded inputs) belt-and-braces branch.
 *
 * A projection failure never fails the terminal transition: the caller gets a
 * valid envelope with `result: null, resultOmitted: 'UNAVAILABLE'` and no
 * descriptors, so the event still reaches the receiver in the requested mode.
 */
import {
  CALLBACK_MAX_ARTIFACT_DESCRIPTORS,
  CALLBACK_MAX_DELIVERY_BODY_BYTES,
  CallbackResultEnvelopeSchema,
  callbackInlineResultWithinBound,
  type CallbackArtifactDescriptor,
  type CallbackResultEnvelope,
  type CallbackResultOmitReason,
  type WebhookEventType,
} from '@du/contracts';
import type { DbClient, TerminalState } from './webhooks';

/**
 * How long a callback artifact reference is advertised as fresh, measured from
 * the terminal instant. 24 h matches the platform's existing operation-file
 * cleanup horizon, so the callback reference never outlives the content it
 * points at. The artifact's own `expires_at`, when present, always wins by
 * being the earlier bound.
 */
export const DEFAULT_CALLBACK_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CallbackResultProjectionInput {
  readonly operationId: string;
  readonly state: TerminalState;
  readonly eventType: WebhookEventType;
  /** Terminal instant (`completed_at`, else the terminal `updated_at`). */
  readonly occurredAt: string;
  /** Policy opt-out: references only, no inline result. */
  readonly forceReferenceOnly?: boolean;
  readonly referenceTtlMs?: number;
}

/**
 * Sealed-envelope discriminator (BA-02 shape). Deliberately structural: the
 * scheduling transaction has no metadata reader, and a ciphertext must never
 * be projected to an external receiver as if it were a business result.
 */
export function looksLikeSealedResultRef(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return record.version === 1
    && record.algorithm === 'aes-256-gcm'
    && typeof record.ciphertext === 'string'
    && typeof record.dek === 'object'
    && record.dek !== null;
}

interface ArtifactRow {
  id: string | null;
  purpose: string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
  file_name: string | null;
  expires_at: string | Date | null;
  submit_roles: unknown;
}

function descriptorExpiryMs(row: ArtifactRow, occurredAtMs: number, ttlMs: number): number {
  const artifactExpiryMs = row.expires_at == null ? Number.NaN : Date.parse(String(row.expires_at));
  const artifactBound = Number.isFinite(artifactExpiryMs) ? artifactExpiryMs : Number.POSITIVE_INFINITY;
  const referenceBound = occurredAtMs + ttlMs;
  return Math.min(artifactBound, referenceBound);
}

function descriptorFor(
  row: ArtifactRow,
  role: string,
  occurredAtMs: number,
  ttlMs: number,
): CallbackArtifactDescriptor | null {
  if (row.id === null) return null;
  const expiryMs = descriptorExpiryMs(row, occurredAtMs, ttlMs);
  if (!Number.isFinite(expiryMs)) return null;
  return {
    artifactId: row.id,
    role,
    ...(row.file_name ? { fileName: row.file_name } : {}),
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    sizeBytes: Number(row.size_bytes ?? 0),
    download: {
      path: `/api/v1/artifacts/${row.id}/download`,
      expiresAt: new Date(expiryMs).toISOString(),
    },
  };
}

async function projectArtifacts(
  client: DbClient,
  operationId: string,
  occurredAtMs: number,
  ttlMs: number,
): Promise<CallbackArtifactDescriptor[]> {
  const res = await client.query(
    `SELECT a.id, a.purpose, a.mime_type, a.size_bytes, a.file_name, a.expires_at,
            COALESCE(o.submit_artifacts, '[]'::jsonb) AS submit_roles
     FROM operations o
     LEFT JOIN artifacts a
       ON a.state = 'READY'
      AND a.tenant_id = o.tenant_id
      AND a.purpose IN ('input', 'output')
      AND (
        (a.operation_id = o.id AND a.purpose = 'output')
        OR COALESCE(o.submit_artifacts, '[]'::jsonb) @>
           jsonb_build_array(jsonb_build_object('artifactId', a.id::text))
      )
     WHERE o.id = $1
     ORDER BY a.id
     LIMIT $2`,
    [operationId, CALLBACK_MAX_ARTIFACT_DESCRIPTORS],
  );
  const rows = res.rows as unknown as ArtifactRow[];
  const submitRoles = new Map<string, string>();
  for (const row of rows) {
    const declared = Array.isArray(row.submit_roles) ? row.submit_roles : [];
    for (const entry of declared) {
      if (
        typeof entry === 'object' && entry !== null
        && typeof (entry as { artifactId?: unknown }).artifactId === 'string'
        && typeof (entry as { role?: unknown }).role === 'string'
      ) {
        submitRoles.set(
          (entry as { artifactId: string }).artifactId,
          (entry as { role: string }).role,
        );
      }
    }
    break;
  }
  const descriptors: CallbackArtifactDescriptor[] = [];
  for (const row of rows) {
    const descriptor = descriptorFor(
      row,
      submitRoles.get(row.id ?? '') ?? row.purpose ?? 'output',
      occurredAtMs,
      ttlMs,
    );
    if (descriptor) descriptors.push(descriptor);
  }
  return descriptors;
}

/** The usage aggregate `usage.project()` reports, or undefined when unreadable. */
async function projectUsage(client: DbClient, operationId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await client.query(
      `SELECT count(*)::text AS count,
              COALESCE(sum((payload->'units'->>'inputTokens')::numeric),0)::text AS input_tokens,
              COALESCE(sum((payload->'units'->>'outputTokens')::numeric),0)::text AS output_tokens,
              COALESCE(sum((payload->>'costMicrousd')::numeric),0)::text AS cost,
              bool_or(payload->>'measurement' = 'estimated') AS estimated
       FROM usage_events WHERE operation_id=$1`,
      [operationId],
    );
    const row = result.rows[0] as
      | { count: string; input_tokens: string; output_tokens: string; cost: string; estimated: boolean | null }
      | undefined;
    if (!row) return undefined;
    const inputTokens = Number(row.input_tokens);
    const outputTokens = Number(row.output_tokens);
    const costMicrousd = Number(row.cost);
    if (![inputTokens, outputTokens, costMicrousd].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return undefined;
    }
    return {
      inputTokens,
      outputTokens,
      costMicrousd,
      measurement: row.count === '0' ? 'pending' : row.estimated ? 'estimated' : 'measured',
    };
  } catch {
    // Usage is informative only; an unreadable ledger must not fail the
    // terminal transition nor invent totals.
    return undefined;
  }
}

/**
 * Build the frozen `notification_with_result` envelope for one terminal
 * transition. Never throws on projection trouble: a valid envelope with an
 * explicit omission reason is returned instead.
 */
export async function buildCallbackResultEnvelope(
  client: DbClient,
  input: CallbackResultProjectionInput,
): Promise<CallbackResultEnvelope> {
  const occurredAtMs = Date.parse(input.occurredAt);
  const ttlMs = input.referenceTtlMs ?? DEFAULT_CALLBACK_REFERENCE_TTL_MS;

  let descriptors: CallbackArtifactDescriptor[] = [];
  let usage: Record<string, unknown> | undefined;
  let result: Record<string, unknown> | null = null;
  let resultOmitted: CallbackResultOmitReason | undefined;

  try {
    descriptors = await projectArtifacts(client, input.operationId, occurredAtMs, ttlMs);
    usage = await projectUsage(client, input.operationId);

    if (input.state !== 'SUCCEEDED') {
      // Failure/cancel/timeout: the authorized result API has no result body
      // for these states; the event + descriptors still travel.
      result = null;
      resultOmitted = 'UNAVAILABLE';
    } else if (input.forceReferenceOnly) {
      result = null;
      resultOmitted = 'UNAVAILABLE';
    } else {
      const opRes = await client.query(
        'SELECT result_ref FROM operations WHERE id=$1',
        [input.operationId],
      );
      const storedRef = (opRes.rows[0] as { result_ref?: string | null } | undefined)?.result_ref ?? null;
      if (storedRef !== null && looksLikeSealedResultRef(storedRef)) {
        // Ciphertext at rest must not be projected as a business result, and
        // this transaction holds no metadata reader to open it.
        result = null;
        resultOmitted = 'ENCRYPTED_ONLY';
      } else {
        const projection: Record<string, unknown> = {
          schemaVersion: '1',
          data: storedRef === null ? {} : { resultRef: storedRef },
          artifacts: descriptors,
          ...(usage === undefined ? {} : { usage }),
          warnings: [],
        };
        const bytes = Buffer.byteLength(JSON.stringify(projection), 'utf8');
        if (callbackInlineResultWithinBound(bytes)) {
          result = projection;
        } else {
          result = null;
          resultOmitted = 'OVERSIZED';
        }
      }
    }
  } catch {
    descriptors = [];
    usage = undefined;
    result = null;
    resultOmitted = 'UNAVAILABLE';
  }

  const envelope: Record<string, unknown> = {
    projectionVersion: '1',
    eventType: input.eventType,
    operationId: input.operationId,
    state: input.state,
    occurredAt: input.occurredAt,
    result,
    artifacts: descriptors,
    ...(usage === undefined ? {} : { usage }),
    ...(resultOmitted === undefined ? {} : { resultOmitted }),
  };

  // Belt-and-braces body bound. With the inline bound + 32 descriptors this is
  // unreachable, but a future field must not silently blow the wire contract.
  let body = JSON.stringify(envelope);
  if (Buffer.byteLength(body, 'utf8') > CALLBACK_MAX_DELIVERY_BODY_BYTES) {
    envelope.result = null;
    envelope.resultOmitted = 'OVERSIZED';
    delete envelope.usage;
    body = JSON.stringify(envelope);
  }
  const artifacts = envelope.artifacts as CallbackArtifactDescriptor[];
  while (Buffer.byteLength(body, 'utf8') > CALLBACK_MAX_DELIVERY_BODY_BYTES && artifacts.length > 0) {
    artifacts.pop();
    body = JSON.stringify(envelope);
  }

  // Final parse pins the exact CB-01 contract (strict, omission consistency).
  return CallbackResultEnvelopeSchema.parse(envelope);
}
