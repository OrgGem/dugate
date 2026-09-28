/**
 * SENTINEL SINK SCAN harness (cycle 138, Reviewer audit 132-137 → SEC-07/G-SEC).
 *
 * Every earlier suite scanned only admin_audit_events + admin_idempotency.
 * This module defines the FULL sink matrix a credential sentinel must never
 * reach, and provides the scanning primitives so that (a) offline unit tests
 * validate the scanner ITSELF (positive controls first — a scan that can
 * never fail is a lie), and (b) the future live SEC-INT run wires the same
 * ids against real PG/Redis/HTTP/log captures with one injected query fn.
 *
 * Leak-safety of the tool itself: failures report ONLY sink ids + sentinel
 * ids — never the matched text, never surrounding snippets.
 */

export interface SentinelSpec {
  /** Stable identifier (what reports show). */
  id: string;
  /** The literal value planted by the live run (opaque here). */
  value: string;
}

export interface SinkSource {
  id: string;
  /** Returns string bodies to scan (rows/frames/log lines). */
  read(): Promise<string[]>;
}

export type SinkMedium = 'pg' | 'http' | 'log' | 'redis' | 'html';

export interface SinkCatalogEntry {
  id: string;
  medium: SinkMedium;
  /** Why this sink exists and what write path feeds it. */
  note: string;
}

export const SINK_CATALOG: readonly SinkCatalogEntry[] = Object.freeze([
  { id: 'pg.admin_audit_events', medium: 'pg', note: 'audit row details/detail JSON (already scanned since cycle 99)' },
  { id: 'pg.admin_idempotency', medium: 'pg', note: 'stored replay response_body (already scanned since cycle 99)' },
  { id: 'pg.connector_revisions', medium: 'pg', note: 'config JSONB + credential_source JSONB — VAULT-01 rejects secret-bearing headers at WRITE time; scan proves it (read-path redaction alone is NOT write-time protection: SEC-03 rule)' },
  { id: 'pg.secret_versions', medium: 'pg', note: 'encrypted_value BYTEA must be ciphertext; plaintext sentinel must never appear in the byte blob' },
  { id: 'pg.connector_invocations', medium: 'pg', note: 'request/result JSONB — ledger stores LocalInvocationRequest (input/ids), NOT the provider HTTP request; the injected bearer must be provably absent' },
  { id: 'pg.connector_usage_outbox', medium: 'pg', note: 'usage event payload JSON — numbers/labels only' },
  { id: 'pg.webhook_deliveries', medium: 'pg', note: 'payload + operator-visible last_error (fixed codes since ADM-BASE-03)' },
  { id: 'pg.orchestrator_outbox', medium: 'pg', note: 'dispatch rows carry ids + refs only' },
  { id: 'http.error_responses', medium: 'http', note: 'ProblemDetails across failure routes: boundary + unexpected paths must carry stable codes only (ADM-BASE-03)' },
  { id: 'log.structured_buffer', medium: 'log', note: 'captured stdout lines run through observability redact() — SEC reuses LOG-01 policy, no parallel redactor' },
  { id: 'redis.job_payload', medium: 'redis', note: 'BullMQ queue payloads (live keyspace read) — must carry ids/refs only' },
  { id: 'html.admin_panes', medium: 'html', note: 'rendered shell sections (masked fetchers since W46-C2; re-scan after VAULT-03 wiring)' },
]);

export class SinkLeakError extends Error {
  readonly findings: Array<{ sinkId: string; sentinelId: string }>;
  constructor(findings: Array<{ sinkId: string; sentinelId: string }>) {
    // NOTE: message names IDs ONLY — never sentinel values or matched text.
    super(
      'sentinel leak detected: ' +
        findings.map((f) => f.sinkId + ' ~ ' + f.sentinelId).join('; '),
    );
    this.name = 'SinkLeakError';
    this.findings = findings;
  }
}

export function scanTextForSentinels(sentinels: readonly SentinelSpec[], text: string): string[] {
  const hits: string[] = [];
  for (const s of sentinels) {
    if (s.value.length > 0 && text.includes(s.value)) hits.push(s.id);
  }
  return hits;
}

/** Scan a set of sink bodies; throws SinkLeakError listing id-pairs on ANY hit. */
export async function assertSinksClean(
  sinks: readonly SinkSource[],
  sentinels: readonly SentinelSpec[],
): Promise<true> {
  const findings: Array<{ sinkId: string; sentinelId: string }> = [];
  for (const sink of sinks) {
    const bodies = await sink.read();
    for (const body of bodies) {
      for (const hit of scanTextForSentinels(sentinels, body)) {
        findings.push({ sinkId: sink.id, sentinelId: hit });
      }
    }
  }
  if (findings.length > 0) throw new SinkLeakError(findings);
  return true;
}

export type PgQuery = (sql: string) => Promise<unknown[]>;

const PG_SINK_QUERIES: ReadonlyArray<[string, string]> = [
  ['pg.admin_audit_events', 'SELECT to_jsonb(t)::text AS j FROM admin_audit_events t'],
  ['pg.admin_idempotency', 'SELECT to_jsonb(t)::text AS j FROM admin_idempotency t'],
  ['pg.connector_revisions', 'SELECT to_jsonb(t)::text AS j FROM connector_revisions t'],
  [
    'pg.secret_versions',
    'SELECT id, credential_ref, encode(encrypted_value, \'escape\') AS j FROM secret_versions t',
  ],
  ['pg.connector_invocations', 'SELECT to_jsonb(t)::text AS j FROM connector_invocations t'],
  ['pg.connector_usage_outbox', 'SELECT to_jsonb(t)::text AS j FROM connector_usage_outbox t'],
  ['pg.webhook_deliveries', 'SELECT to_jsonb(t)::text AS j FROM webhook_deliveries t'],
  ['pg.orchestrator_outbox', 'SELECT to_jsonb(t)::text AS j FROM outbox t'],
];

/**
 * Live-run wiring: every pg sink in the catalog maps to one whole-row JSON
 * query (to_jsonb so ANY column, incl. future ones, is covered without
 * enumerating). Rows are stringified for scanning.
 */
export function buildPgSinks(query: PgQuery): SinkSource[] {
  return PG_SINK_QUERIES.map(([id, sql]) => ({
    id,
    read: async () => {
      const rows = await query(sql);
      return rows.map((r) => JSON.stringify(r));
    },
  }));
}

/** Captured-log sink; the caller supplies the raw buffer (e.g., stdout spy). */
export function buildLogSink(id: string, capture: () => string): SinkSource {
  return { id, read: async () => [capture()] };
}
