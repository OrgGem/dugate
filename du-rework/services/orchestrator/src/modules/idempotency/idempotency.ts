import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Db } from '../../db/db';
import { HttpError } from '../../http/errors';

/**
 * Admin POST idempotency (R2-A priority-5; review.md cycle 6/6 MEDIUM
 * "retried mutating POST is not idempotent proof").
 *
 * Contract: a client that sends `Idempotency-Key` (or `Client-Token`) on an
 * admin mutating POST and then RETRIES the same request — because the
 * socket died or the response was lost — gets the FIRST request's stored
 * response back verbatim, with header `idempotent-replay: true`, and the
 * platform writes NOTHING on the retry: no second profile revision, no
 * second audit row, no second marker. Reusing a key with a different
 * payload (or on a different route) is a 409, never a silent overwrite.
 *
 * Atomicity is the point (it composes with auditedMutation's single
 * transaction): the marker INSERT runs on the SAME client as mutation +
 * audit, so a marker failure rolls the whole request back and a committed
 * mutation always has exactly one marker + one audit row. Two concurrent
 * first-requests with the same key race on the PRIMARY KEY; the loser
 * catches the unique violation, its transaction is rolled back, and it
 * replays the winner's stored response instead.
 *
 * Requests WITHOUT the header keep the pre-existing behavior byte-for-byte
 * (legacy path; no dedup claimed).
 */

export const ADMIN_IDEMPOTENCY_TABLE = 'admin_idempotency';

export interface IdempotentResponse<T = unknown> {
  status: number;
  body: T;
}

export interface IdempotencyRequest {
  /** undefined when the client sent no header → pass-through. */
  key?: string;
  /** Stable route id, e.g. 'POST /api/v1/admin/profile-bindings'. */
  route: string;
  /** canonicalPayloadHash(ctx.body). */
  payloadHash: string;
}

interface MarkerRow {
  key: string;
  route: string;
  payload_hash: string;
  response_code: number;
  response_body: unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** sha256 over canonical JSON (sorted keys, recursive). Stable across
 *  serialization order, so a faithful client retry hashes identically. */
export function canonicalPayloadHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body ?? {}))).digest('hex');
}

const KEY_RE = /^[!-~]{8,200}$/;

/** Read + validate the idempotency token. 422 on malformed (fail closed —
 *  a silently-ignored bad key would promise protection it cannot give). */
export function readIdempotencyKey(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers['idempotency-key'] ?? headers['client-token'];
  if (raw === undefined || raw === '') return undefined;
  if (!KEY_RE.test(raw)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'Idempotency-Key must be 8-200 printable ASCII characters');
  }
  return raw;
}

function isMarkerConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  return (
    e?.code === '23505' &&
    ((e.constraint ?? '').includes(ADMIN_IDEMPOTENCY_TABLE + '_pkey') ||
      (e.message ?? '').includes(ADMIN_IDEMPOTENCY_TABLE))
  );
}

async function findMarker(db: Db, key: string): Promise<MarkerRow | undefined> {
  const res = await db.query<MarkerRow>(
    `SELECT key, route, payload_hash, response_code, response_body
     FROM ${ADMIN_IDEMPOTENCY_TABLE} WHERE key = $1`,
    [key]
  );
  return res.rows[0];
}

function decide(row: MarkerRow, req: IdempotencyRequest): IdempotentResponse & { replayed: boolean } {
  if (row.route !== req.route) {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used on a different route');
  }
  if (row.payload_hash !== req.payloadHash) {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different payload');
  }
  return { status: row.response_code, body: row.response_body, replayed: true };
}

export async function executeIdempotent<T>(
  db: Db,
  req: IdempotencyRequest,
  work: (withMarker: (client: PoolClient, response: IdempotentResponse<T>) => Promise<void>) => Promise<IdempotentResponse<T>>
): Promise<IdempotentResponse<T> & { replayed: boolean }> {
  if (!req.key) {
    // Legacy path: no header => run exactly once per request, no marker.
    return { ...(await work(async () => { throw new Error('withMarker called without an idempotency key'); })), replayed: false };
  }

  const existing = await findMarker(db, req.key);
  if (existing) return decide(existing, req) as IdempotentResponse<T> & { replayed: boolean };

  let markerWritten = false;
  const withMarker = async (client: PoolClient, response: IdempotentResponse<T>): Promise<void> => {
    await client.query(
      `INSERT INTO ${ADMIN_IDEMPOTENCY_TABLE}
         (key, route, payload_hash, response_code, response_body)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.key, req.route, req.payloadHash, response.status, JSON.stringify(response.body)]
    );
    markerWritten = true;
  };

  let outcome: IdempotentResponse<T>;
  try {
    outcome = await work(withMarker);
  } catch (err) {
    if (isMarkerConflict(err)) {
      // Lost the first-request race: our whole transaction (mutation +
      // audit + marker) rolled back; the winner's response is canonical.
      const winner = await findMarker(db, req.key);
      if (winner) return decide(winner, req) as IdempotentResponse<T> & { replayed: boolean };
    }
    throw err;
  }
  if (!markerWritten) {
    throw new Error('executeIdempotent: work resolved without persisting its marker inside the transaction');
  }
  return { ...outcome, replayed: false };
}

/** Ops retention helper (docs/04 "Không xóa ... sớm hơn cửa sổ retry/replay
 *  được công bố"): delete markers older than the given window. NOT wired to
 *  any timer — a retention job needs its own decision + runbook entry. */
export async function purgeIdempotencyMarkers(db: Db, olderThanMs: number): Promise<number> {
  const res = await db.query(
    `DELETE FROM ${ADMIN_IDEMPOTENCY_TABLE}
      WHERE created_at < now() - ($1 * interval '1 ms')
      RETURNING key`,
    [olderThanMs]
  );
  return res.rowCount ?? 0;
}
