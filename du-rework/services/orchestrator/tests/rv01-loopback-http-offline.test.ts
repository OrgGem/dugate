/**
 * RV01 - loopback HTTP proof for the legacy compat facade.
 *
 * ## What this closes
 *
 * Every existing legacy test drives `handleLegacyRoute` (or `legacyCompatHost`)
 * in-process. Nothing had yet put a real socket under them, so three things
 * were unproven: that `server.ts` really routes the multipart request to the
 * facade instead of dropping it, that the streaming ingress branch in
 * `server.ts` is the branch that actually runs for a legacy submit, and that
 * the status codes / headers / envelopes survive a real HTTP response.
 *
 * This suite mounts the REAL `route()` from `src/server.ts` on a loopback
 * `node:http` server whose listener is a transcription of `createApp`'s
 * (server.ts:717-849): the same `isLegacyCompat` predicate, the same
 * `bodyStream: req` passthrough, the same `HttpError -> problem+json` mapping,
 * the same raw/JSON split. The facade itself is the shipped one - only the
 * database and the four services the facade touches are faked.
 *
 * Modelled on tests/admin-operations-sort-http-offline.test.ts, which uses the
 * same technique for the canonical operations list.
 *
 * OFFLINE ONLY: loopback sockets, no PostgreSQL, no Redis, no S3, no DB window.
 * Expectations are transcribed from the legacy du-gate routes (app/api/v1/**)
 * and from docs/39-legacy-parity-contract.md, NOT from the facade's own code,
 * so a change in the facade that breaks parity fails here.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { isHttpError } from '../src/http/errors';
import { readBoundedBody, type IngressBody } from '../src/http/ingress';
import { route, type RouteContext } from '../src/server';
import { writePublicArtifact } from '../src/compat/legacy-public-artifact';

const API_KEY = 'rv01-loopback-key';
const API_KEY_HASH = createHash('sha256').update(API_KEY).digest('hex');
const ADMIN_TOKEN = 'rv01-loopback-admin-token';
const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_TENANT = '33333333-3333-4333-8333-333333333333';

interface PgResult {
  rowCount: number | null;
  rows: Record<string, unknown>[];
  command: string;
  oid: number;
  fields: unknown[];
}

function pgResult(rows: Record<string, unknown>[]): PgResult {
  return { rowCount: rows.length, rows, command: 'SELECT', oid: 0, fields: [] };
}

type OpRow = Record<string, unknown>;

const TERMINAL: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * A database row carrying every column EITHER projection reads: the legacy
 * adapter (migration 0024 columns) and the canonical `toOperationView`.
 */
function newOperation(over: OpRow = {}): OpRow {
  return {
    id: randomUUID(),
    tenant_id: TENANT,
    api_key_id: KEY_ID,
    business_id: 'document-core',
    business_version: '1.0.0',
    action: 'extract',
    state: 'RUNNING',
    state_version: 1,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:01.000Z',
    deadline_at: null,
    deleted_at: null,
    result_ref: null,
    submit_artifacts: null,
    pipeline_json: null,
    steps_result_json: null,
    current_step: null,
    progress_percent: null,
    progress_message: null,
    output_format: null,
    output_content: null,
    extracted_data: null,
    total_input_tokens: null,
    total_output_tokens: null,
    pages_processed: null,
    model_used: null,
    total_cost_usd: null,
    usage_breakdown: null,
    error_code: null,
    error_message: null,
    failed_at_step: null,
    endpoint_slug: null,
    ...over,
  };
}

/**
 * SQL interpreter over the in-memory store.
 *
 * It answers only the statements the compat facade and the canonical
 * operations list actually issue. An unrecognised statement THROWS instead of
 * returning an empty page: a silent `rows: []` would let a broken predicate
 * look like an empty tenant rather than naming the SQL that drifted.
 */
class FakeDb {
  operations: OpRow[] = [];
  apiKeys: Record<string, unknown>[] = [];
  artifacts: Record<string, unknown>[] = [];
  readonly statements: string[] = [];

  reset(): void {
    this.operations = [];
    this.apiKeys = [];
    this.artifacts = [];
    this.statements.length = 0;
  }

  async query(sql: string, params: unknown[] = []): Promise<PgResult> {
    this.statements.push(sql);
    const norm = sql.replace(/\s+/g, ' ').trim();
    const low = norm.toLowerCase();

    // resolveApiKey: hash lookup, ACTIVE only.
    if (low.startsWith('select id, tenant_id from api_keys where hash=')) {
      const hit = this.apiKeys.find((k) => k.hash === params[0] && k.status === params[1]);
      return pgResult(hit ? [{ id: hit.id, tenant_id: hit.tenant_id }] : []);
    }

    // legacy billing: the key row supplies name + limits.
    if (low.startsWith('select name, spending_limit, total_used from api_keys where id =')) {
      const hit = this.apiKeys.find((k) => k.id === params[0]);
      return pgResult(
        hit ? [{ name: hit.name, spending_limit: hit.spending_limit, total_used: hit.total_used }] : []
      );
    }

    if (low.startsWith('insert into artifacts')) {
      this.artifacts.push({
        id: params[0],
        tenant_id: params[1],
        file_name: params[2],
        mime_type: params[3],
        size_bytes: params[4],
        sha256: params[5],
      });
      return pgResult([]);
    }

    // cancelLegacy
    if (low.startsWith("update operations set state = 'cancel_requested'")) {
      const row = this.live(String(params[0]), String(params[1]));
      if (row === undefined) return pgResult([]);
      if (TERMINAL.has(String(row.state))) return pgResult([]);
      row.state = 'CANCEL_REQUESTED';
      row.state_version = Number(row.state_version) + 1;
      row.updated_at = '2026-10-01T12:00:00.000Z';
      return pgResult([{ ...row }]);
    }

    // softDeleteOperation
    if (low.startsWith('update operations set deleted_at')) {
      const row = this.live(String(params[0]), String(params[1]));
      if (row === undefined) return pgResult([]);
      row.deleted_at = '2026-10-01T13:00:00.000Z';
      return pgResult([{ ...row }]);
    }

    if (low.startsWith('select output_content from operations')) {
      const row = this.live(String(params[0]), String(params[1]));
      return pgResult(row === undefined ? [] : [{ output_content: row.output_content }]);
    }

    // canonical list count (checked before the billing count: 'as total' vs 'as n').
    // Filters only - a COUNT carries no ORDER BY or LIMIT to read.
    if (low.startsWith('select count(*)::int as total from operations')) {
      return pgResult([{ total: this.applyFilters(low, params).length }]);
    }

    if (low.startsWith('select count(*)::int as n from operations')) {
      const rows = this.operations.filter(
        (o) =>
          o.api_key_id === params[0] &&
          o.state === 'SUCCEEDED' &&
          o.deleted_at === null
      );
      return pgResult([{ n: rows.length }]);
    }

    // legacy billing: per-model spend.
    if (low.startsWith('select model_used,')) {
      const rows = this.operations.filter(
        (o) =>
          o.api_key_id === params[0] &&
          o.state === 'SUCCEEDED' &&
          o.deleted_at === null
      );
      const byModel = new Map<string, { p: number; c: number; g: number; k: number }>();
      for (const r of rows) {
        const model = r.model_used === null ? 'unknown' : String(r.model_used);
        const acc = byModel.get(model) ?? { p: 0, c: 0, g: 0, k: 0 };
        acc.p += Number(r.total_input_tokens ?? 0);
        acc.c += Number(r.total_output_tokens ?? 0);
        acc.g += Number(r.pages_processed ?? 0);
        acc.k += Number(r.total_cost_usd ?? 0);
        byModel.set(model, acc);
      }
      return pgResult(
        [...byModel.entries()].map(([model, a]) => ({
          model_used: model,
          prompt_tokens: a.p,
          completion_tokens: a.c,
          pages_processed: a.g,
          cost_usd: a.k,
        }))
      );
    }

    if (low.startsWith('select * from operations where id =')) {
      const row = this.live(String(params[0]), String(params[1]));
      return pgResult(row === undefined ? [] : [{ ...row }]);
    }

    if (low.startsWith('select * from operations')) {
      return pgResult(this.selectOperations(low, params).map((r) => ({ ...r })));
    }

    throw new Error('fake db received an unmodelled statement: ' + norm);
  }

  private live(id: string, tenantId: string): OpRow | undefined {
    return this.operations.find((o) => o.id === id && o.tenant_id === tenantId && o.deleted_at === null);
  }

  /**
   * Shared filter/sort for BOTH list statements. They differ only in their
   * predicate set (the legacy one always carries `deleted_at IS NULL`) and in
   * how the page boundary is expressed - a uuid lookup subquery for the legacy
   * `page_token`, a row-value comparison for the canonical cursor.
   */
  private applyFilters(low: string, params: unknown[]): OpRow[] {
    let rows = this.operations.slice();

    const tenant = /tenant_id = \$(\d+)/.exec(low);
    if (tenant) rows = rows.filter((o) => o.tenant_id === String(params[Number(tenant[1]) - 1]));

    if (low.includes('deleted_at is null')) rows = rows.filter((o) => o.deleted_at === null);

    const state = /state = any\(\$(\d+)::text\[\]\)/.exec(low);
    if (state) {
      const wanted = params[Number(state[1]) - 1] as string[];
      rows = rows.filter((o) => wanted.includes(String(o.state)));
    }

    for (const m of low.matchAll(/pipeline_json::text ilike \$(\d+)/g)) {
      const needle = String(params[Number(m[1]) - 1]).replace(/%/g, '').toLowerCase();
      rows = rows.filter((o) =>
        String(o.pipeline_json ?? '').toLowerCase().includes(needle)
      );
    }

    return rows;
  }

  private selectOperations(low: string, params: unknown[]): OpRow[] {
    let rows = this.applyFilters(low, params);

    const keyOf = (r: OpRow): string => {
      if (low.includes('order by coalesce(deadline_at')) {
        const asc = /order by coalesce\(deadline_at[^)]*\) asc/.test(low);
        return String(r.deadline_at ?? (asc ? '9999-12-31T23:59:59.999Z' : '0001-01-01T00:00:00.000Z'));
      }
      if (low.includes('order by updated_at')) return String(r.updated_at);
      return String(r.created_at);
    };

    // page boundary: the legacy uuid lookup, or the canonical row value.
    const legacyBoundary = /\(created_at, id\) < \(select created_at, id from operations where id = \$(\d+)\)/.exec(low);
    const canonicalBoundary = /\(created_at, id\) [<>] \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/.exec(low);
    if (legacyBoundary !== null) {
      const anchor = this.operations.find((o) => o.id === String(params[Number(legacyBoundary[1]) - 1]));
      if (anchor === undefined) throw new Error('legacy page_token named no operation: ' + params[Number(legacyBoundary[1]) - 1]);
      rows = rows.filter((o) =>
        String(o.created_at) < String(anchor.created_at) ||
        (String(o.created_at) === String(anchor.created_at) && String(o.id) < String(anchor.id)),
      );
    } else if (canonicalBoundary !== null) {
      const at = String(params[Number(canonicalBoundary[1]) - 1]);
      const id = String(params[Number(canonicalBoundary[2]) - 1]);
      const op = canonicalBoundary[2] === undefined ? '<' : (canonicalBoundary[0].includes('>') ? '>' : '<');
      rows = rows.filter((o) => {
        const k = keyOf(o);
        if (k === at) return op === '<' ? String(o.id) < id : String(o.id) > id;
        return op === '<' ? k < at : k > at;
      });
    }

    const order = /order by (.+?) (asc|desc)(?:, id (asc|desc))? limit \$(\d+)/.exec(low);
    if (order === null) throw new Error('unparsed page ORDER BY/LIMIT: ' + low);
    const direction = (order[2] ?? 'desc').toUpperCase();
    const factor = direction === 'ASC' ? 1 : -1;
    const limit = Number(params[Number(order[4]) - 1]);

    rows.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      if (ka !== kb) return ka < kb ? -factor : factor;
      return String(a.id) < String(b.id) ? -factor : factor;
    });
    return rows.slice(0, limit);
  }
}

// ---------------------------------------------------------------------
// Loopback HTTP plumbing
// ---------------------------------------------------------------------

interface Wire {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  raw: Buffer;
  body: string;
  timedOut: boolean;
  aborted: boolean;
}

function wireRequest(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    let aborted = false;
    let settled = false;
    let answered = false;
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port),
        path,
        method,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        // A response the server declares a length for but does not fill is
        // torn down by Node: the client sees 'aborted' and NEVER 'end', and the
        // socket timeout does not fire either. Settling on 'aborted' is what
        // keeps a truncated response from hanging the suite for its whole
        // 120s budget - and truncated IS the observation worth recording.
        const settle = (): void => {
          if (answered) return;
          answered = true;
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            raw,
            body: raw.toString('utf8'),
            timedOut: false,
            aborted,
          });
        };
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('aborted', () => {
          aborted = true;
          settle();
        });
        res.on('end', settle);
        res.on('error', settle);
      },
    );
    // A Content-Length the server never honours must not hang the suite for
    // its whole 120s budget - the truncation IS the finding, so record it.
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({
        status: 0,
        headers: {},
        raw: Buffer.alloc(0),
        body: '',
        timedOut: true,
        aborted,
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

interface Part {
  name: string;
  value?: string;
  fileName?: string;
  contentType?: string;
  content?: Buffer;
}

const CRLF = '\r\n';

function buildMultipart(boundary: string, parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}${CRLF}`;
    if (part.fileName !== undefined) {
      head += `Content-Disposition: form-data; name="${part.name}"; filename="${part.fileName}"${CRLF}`;
      head += `Content-Type: ${part.contentType ?? 'application/octet-stream'}${CRLF}${CRLF}`;
      chunks.push(Buffer.from(head, 'latin1'));
      chunks.push(part.content ?? Buffer.alloc(0));
    } else {
      head += `Content-Disposition: form-data; name="${part.name}"${CRLF}${CRLF}`;
      chunks.push(Buffer.from(head, 'latin1'));
      chunks.push(Buffer.from(String(part.value ?? ''), 'utf8'));
    }
    chunks.push(Buffer.from(CRLF, 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'latin1'));
  return Buffer.concat(chunks);
}

let boundarySeq = 0;

function multipart(
  parts: Part[],
): { body: Buffer; contentType: string } {
  boundarySeq += 1;
  const boundary = `----rv01${String(boundarySeq).padStart(6, '0')}X9Y`;
  return {
    body: buildMultipart(boundary, parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const PDF = Buffer.from('%PDF-1.4\n% rv01 fixture\n', 'latin1');

// ---------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------

interface RecordedArtifact {
  fileName: unknown;
  role: string;
  sizeBytes: unknown;
}

interface SubmissionCall {
  businessId: string;
  action: string;
  apiKeyId: string;
  tenantId: string;
  idempotencyKey?: string;
  submission: Record<string, unknown>;
}

describe('RV01 legacy compat facade over real loopback HTTP', () => {
  const db = new FakeDb();
  const server = http.createServer();
  let base = '';
  const artifacts: RecordedArtifact[] = [];
  const submissions: SubmissionCall[] = [];
  const resumes: unknown[] = [];
  const idempotency = new Map<string, string>();

  // Ephemeral ports are destination-filtered on this Windows box; pin a base
  // disjoint from the cross-sort suite.
  const PORT = 47_800 + (process.pid % 20);

  beforeAll(async () => {
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const correlationId = 'rv01-correlation';
        res.setHeader('x-correlation-id', correlationId);
        res.setHeader('content-type', 'application/json');
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const method = req.method ?? 'GET';

        // --- transcription of server.ts:726-760 -----------------------------
        const isBlobPut =
          method === 'PUT' && /^\/api\/runtime\/v1\/artifacts\/blob\/[^/]+$/.test(url.pathname);
        const isLegacyCompat =
          method === 'POST' &&
          /^\/api\/v1\/docs\/[a-z-]+(?:\/schema)?$/.test(url.pathname) &&
          (req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data');
        let ingress: IngressBody;
        try {
          ingress = isLegacyCompat
            ? { body: undefined, rawBody: Buffer.alloc(0) }
            : await readBoundedBody(req, { binary: isBlobPut });
        } catch (err) {
          if (res.writableEnded || res.destroyed) return;
          if (isHttpError(err)) {
            res.setHeader('content-type', 'application/problem+json');
            res.statusCode = err.status;
            res.end(JSON.stringify(err.toProblem(correlationId)));
            return;
          }
          res.statusCode = 500;
          res.end('{"code":"INTERNAL"}');
          return;
        }

        try {
          const result = await route(
            makeCtx({
              method,
              pathname: url.pathname,
              searchParams: url.searchParams,
              headers: req.headers as Record<string, string>,
              correlationId,
              host: req.headers.host ?? 'localhost',
              ...ingress,
              ...(isLegacyCompat ? { bodyStream: req } : {}),
            }),
          );
          res.statusCode = result.status;
          for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
          if (result.raw instanceof Buffer) {
            res.setHeader('content-length', String(result.raw.length));
            res.end(result.raw);
          } else {
            res.end(JSON.stringify(result.body ?? {}));
          }
        } catch (err) {
          if (res.headersSent || res.destroyed) {
            res.destroy();
            return;
          }
          if (isHttpError(err)) {
            res.setHeader('content-type', 'application/problem+json');
            res.statusCode = err.status;
            res.end(JSON.stringify(err.toProblem(correlationId)));
            return;
          }
          // server.ts answers sanitizedInternalError here. This harness echoes
          // the class and message instead: it is a test double, and a red that
          // only says {"code":"INTERNAL"} costs a whole debugging cycle to
          // attribute.
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              code: 'INTERNAL',
              name: err instanceof Error ? err.name : typeof err,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      })();
    });

    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
    base = `http://127.0.0.1:${String(PORT)}`;
  });

  afterAll(async () => {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  });

  beforeEach(() => {
    db.reset();
    artifacts.length = 0;
    submissions.length = 0;
    resumes.length = 0;
    idempotency.clear();
    db.apiKeys.push({
      id: KEY_ID,
      tenant_id: TENANT,
      hash: API_KEY_HASH,
      prefix: 'rv01',
      status: 'ACTIVE',
      name: 'RV01 key',
      spending_limit: '0',
      total_used: '0',
    });
  });

  function makeCtx(input: {
    method: string;
    pathname: string;
    searchParams: URLSearchParams;
    headers: Record<string, string>;
    correlationId: string;
    host: string;
    body: unknown;
    rawBody: Buffer;
    bodyStream?: AsyncIterable<Uint8Array>;
  }): RouteContext {
    return {
      method: input.method,
      pathname: input.pathname,
      searchParams: input.searchParams,
      headers: input.headers,
      body: input.body,
      rawBody: input.rawBody,
      ...(input.bodyStream ? { bodyStream: input.bodyStream } : {}),
      correlationId: input.correlationId,
      host: input.host,
      db: { query: (sql: string, params?: unknown[]) => db.query(sql, params ?? []) },
      config: { adminToken: ADMIN_TOKEN },
      artifacts: {
        putPublicArtifact: async (a: {
          tenantId: string;
          fileName: string | null;
          mimeType: string;
          bytes: Buffer;
        }) => writePublicArtifact(artifactDeps(), a),
      },
      submission: {
        submit: async (s: SubmissionCall) => {
          submissions.push(s);
          const prior =
            typeof s.idempotencyKey === 'string' ? idempotency.get(s.idempotencyKey) : undefined;
          if (prior !== undefined) {
            const existing = db.operations.find((o) => o.id === prior && o.tenant_id === s.tenantId);
            if (existing !== undefined) {
              return {
                operation: {
                  id: String(existing.id),
                  state: String(existing.state),
                  stateVersion: Number(existing.state_version),
                },
                replayed: true,
                correlationId: input.correlationId,
              };
            }
          }
          const submitted = s.submission.artifacts as
            | { artifactId: string; role: string }[]
            | undefined;
          for (const a of submitted ?? []) {
            const row = db.artifacts.find((x) => x.id === a.artifactId);
            artifacts.push({
              fileName: row?.file_name,
              role: a.role,
              sizeBytes: row?.size_bytes,
            });
          }
          const created = newOperation({
            tenant_id: s.tenantId,
            api_key_id: s.apiKeyId,
            business_id: s.businessId,
            action: s.action,
            state: 'PENDING',
          });
          db.operations.push(created);
          if (typeof s.idempotencyKey === 'string') idempotency.set(s.idempotencyKey, String(created.id));
          return {
            operation: {
              id: String(created.id),
              state: 'PENDING',
              stateVersion: 1,
            },
            replayed: false,
            correlationId: input.correlationId,
          };
        },
      },
      runtime: {
        resumeOperation: async (id: string, tenantId: string, body: unknown) => {
          resumes.push({ id, tenantId, body });
          const row = db.operations.find((o) => o.id === id && o.tenant_id === tenantId);
          if (row !== undefined) {
            row.state = 'RUNNING';
            row.state_version = Number(row.state_version) + 1;
          }
          return { replayed: false };
        },
      },
    } as unknown as RouteContext;
  }

  /**
   * The REAL `writePublicArtifact`, with only its three storage seams faked,
   * so the digest / size-check / INSERT ordering under test is the shipped one.
   */
  function artifactDeps() {
    return {
      query: (sql: string, params?: unknown[]) => db.query(sql, params ?? []),
      putBlob: async () => undefined,
      verifyAndPin: async (i: { objectKey: string }) => ({ objectKey: i.objectKey, versionId: 'v1' }),
      storageBackend: 'postgres' as const,
      maxArtifactBytes: 64 * 1024 * 1024,
    };
  }

  function keyHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-api-key': API_KEY, ...extra };
  }

  async function postAction(
    action: string,
    parts: Part[],
    opts: { query?: string; headers?: Record<string, string> } = {},
  ): Promise<Wire> {
    const mp = multipart(parts);
    return wireRequest(base, 'POST', `/api/v1/docs/${action}${opts.query ?? ''}`, {
      ...keyHeaders(opts.headers ?? {}),
      'content-type': mp.contentType,
      'content-length': String(mp.body.length),
    }, mp.body);
  }

  function json(res: Wire): Record<string, unknown> {
    return JSON.parse(res.body) as Record<string, unknown>;
  }

  it('the harness is really mounted: an unknown path reaches the canonical 404', async () => {
    const res = await wireRequest(base, 'GET', '/api/v1/rv01-no-such-route', {});
    expect(res.status).toBe(404);
    expect(json(res).type).toBe('urn:du:error:not_found');
  });

  const JSON_HEADERS = { 'content-type': 'application/json', 'content-length': '2' };
  const JSON_BODY = Buffer.from('{}', 'utf8');

  const filePart = (name: string, fileName: string): Part => ({
    name,
    fileName,
    contentType: 'application/pdf',
    content: PDF,
  });

  interface ActionFixture {
    readonly action: string;
    readonly discriminator: readonly [string, string];
    readonly parts: Part[];
    readonly roles: string[];
  }

  const ACTION_FIXTURES: readonly ActionFixture[] = [
    { action: 'ingest', discriminator: ['mode', 'parse'], parts: [filePart('files[]', 'a.pdf')], roles: ['source'] },
    { action: 'extract', discriminator: ['type', 'invoice'], parts: [filePart('file', 'b.pdf')], roles: ['source'] },
    { action: 'analyze', discriminator: ['task', 'classify'], parts: [filePart('file', 'c.pdf')], roles: ['source'] },
    { action: 'transform', discriminator: ['action', 'convert'], parts: [filePart('file', 'd.pdf')], roles: ['source'] },
    { action: 'generate', discriminator: ['task', 'summary'], parts: [], roles: [] },
    {
      action: 'compare',
      discriminator: ['mode', 'diff'],
      parts: [filePart('source_file', 'src.pdf'), filePart('target_file', 'tgt.pdf')],
      roles: ['source', 'target'],
    },
  ];

  function actionParts(fixture: ActionFixture): Part[] {
    return [
      { name: fixture.discriminator[0], value: fixture.discriminator[1] },
      ...fixture.parts,
    ];
  }

  // ===================================================================
  // A. Submit - the six core actions, over a real multipart request
  // ===================================================================

  it.each(ACTION_FIXTURES.map((fx) => [fx.action, fx] as const))(
    'POST /api/v1/docs/%s answers 202 + Operation-Location + the legacy envelope',
    async (_slug, fixture) => {
      const res = await postAction(fixture.action, actionParts(fixture));
      expect(res.status).toBe(202);
      const body = json(res);
      const id = String(body.name).replace('operations/', '');
      expect(res.headers['operation-location']).toBe(`/api/v1/operations/${id}`);
      expect(body.done).toBe(false);
      // The legacy formatter always wrote exactly these three top-level keys
      // for an unsettled operation; a `result` here would be a wire change.
      expect(Object.keys(body).sort()).toEqual(['done', 'metadata', 'name']);
      const md = body.metadata as Record<string, unknown>;
      expect(Object.keys(md).sort()).toEqual([
        'create_time',
        'current_step',
        'pipeline',
        'pipeline_steps',
        'progress_message',
        'progress_percent',
        'state',
        'update_time',
      ]);
      expect(md.state).toBe('PENDING');
      expect(md.pipeline).toEqual([]);
      expect(md.pipeline_steps).toEqual([]);
      expect(md.current_step).toBeNull();
      expect(md.progress_percent).toBeNull();
      expect(submissions).toHaveLength(1);
      expect(submissions[0]!.businessId).toBe('document-core');
      expect(submissions[0]!.apiKeyId).toBe(KEY_ID);
      expect(submissions[0]!.action).toBe(fixture.action);
      expect(artifacts.map((a) => a.role)).toEqual(fixture.roles);
    },
  );

  it('compare keeps source_file ahead of target_file so the two roles stay distinct', async () => {
    const fixture = ACTION_FIXTURES[5]!;
    await postAction('compare', actionParts(fixture));
    expect(artifacts.map((a) => a.fileName)).toEqual(['src.pdf', 'tgt.pdf']);
    expect(artifacts.map((a) => a.role)).toEqual(['source', 'target']);
    expect(artifacts.every((a) => Number(a.sizeBytes) === PDF.length)).toBe(true);
  });

  it('?sync=true answers 200 with NO Operation-Location, done still false', async () => {
    const res = await postAction(
      'extract',
      [{ name: 'type', value: 'invoice' }, filePart('file', 'sync.pdf')],
      { query: '?sync=true' },
    );
    expect(res.status).toBe(200);
    expect(res.headers['operation-location']).toBeUndefined();
    expect(json(res).done).toBe(false);
  });

  it('a replayed idempotency-key answers 200 with no Operation-Location and no second submit', async () => {
    const parts = (): Part[] => [{ name: 'type', value: 'invoice' }, filePart('file', 'idem.pdf')];
    const first = await postAction('extract', parts(), { headers: { 'idempotency-key': 'k-1' } });
    expect(first.status).toBe(202);
    const second = await postAction('extract', parts(), { headers: { 'idempotency-key': 'k-1' } });
    expect(second.status).toBe(200);
    expect(second.headers['operation-location']).toBeUndefined();
    expect(json(second).name).toBe(json(first).name);
    // The submission service IS entered on a replay - it is what recognises the
    // key and returns the first operation. What must not happen is a SECOND
    // operation row.
    expect(submissions).toHaveLength(2);
    expect(db.operations).toHaveLength(1);
    expect(artifacts.map((a) => a.role)).toEqual(['source']);
  });

  it('output_format reaches the submission verbatim and defaults to json', async () => {
    await postAction('generate', [
      { name: 'task', value: 'summary' },
      { name: 'output_format', value: 'markdown' },
    ]);
    expect((submissions[0]!.submission.output as Record<string, unknown>).format).toBe('markdown');
    submissions.length = 0;
    await postAction('generate', [{ name: 'task', value: 'summary' }]);
    expect((submissions[0]!.submission.output as Record<string, unknown>).format).toBe('json');
  });

  it('an unknown variant is a 400 Invalid Parameter in the legacy problem shape', async () => {
    const res = await postAction('extract', [
      { name: 'type', value: 'not-a-variant' },
      filePart('file', 'x.pdf'),
    ]);
    expect(res.status).toBe(400);
    const body = json(res);
    expect(body.type).toBe('https://dugate.vn/errors/invalid-parameter');
    expect(body.title).toBe('Invalid Parameter');
    expect(body.status).toBe(400);
    expect(String(body.detail)).toContain('not-a-variant');
  });

  it('extract with a discriminator but no file still submits, with no artifact', async () => {
    const res = await postAction('extract', [{ name: 'type', value: 'invoice' }]);
    expect(res.status).toBe(202);
    // The 'Missing Files' guard fires only when a FILE-LIKE value was seen but
    // did not survive into the decoded submission. With no file part at all,
    // presence.fileFields is empty too, so the submit proceeds fileless.
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.submission.artifacts).toBeUndefined();
    expect(artifacts).toHaveLength(0);
  });

  it('GET on a docs action is 405 in the legacy vocabulary', async () => {
    const res = await wireRequest(base, 'GET', '/api/v1/docs/extract', keyHeaders());
    expect(res.status).toBe(405);
    const body = json(res);
    expect(body.type).toBe('https://dugate.vn/errors/method-not-allowed');
    expect(body.title).toBe('Method Not Allowed');
    expect(body.detail).toBe('extract accepts POST only');
  });

  // ===================================================================
  // B. Operation reads
  // ===================================================================

  it('GET a SUCCEEDED operation returns the full legacy result block', async () => {
    const row = newOperation({
      state: 'SUCCEEDED',
      endpoint_slug: 'extract',
      output_format: 'markdown',
      output_content: '# hello',
      extracted_data: { total: 42 },
      steps_result_json: JSON.stringify([{ processor: 'invoice-parser' }]),
      pipeline_json: JSON.stringify([{ processor: 'invoice-parser' }, { processor: 'enricher' }]),
      current_step: 2,
      progress_percent: 100,
      progress_message: 'done',
      total_input_tokens: 10,
      total_output_tokens: 20,
      pages_processed: 3,
      model_used: 'gpt-x',
      total_cost_usd: '0.012500',
      usage_breakdown: JSON.stringify([{ k: 1 }]),
    });
    db.operations.push(row);
    const res = await wireRequest(base, 'GET', `/api/v1/operations/${String(row.id)}`, keyHeaders());
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.name).toBe(`operations/${String(row.id)}`);
    expect(body.done).toBe(true);
    const md = body.metadata as Record<string, unknown>;
    expect(md.pipeline).toEqual(['invoice-parser', 'enricher']);
    expect(md.current_step).toBe(2);
    expect(md.progress_percent).toBe(100);
    expect(md.pipeline_steps).toEqual([{ processor: 'invoice-parser' }]);
    const result = body.result as Record<string, unknown>;
    expect(result.output_format).toBe('markdown');
    expect(result.content).toBe('# hello');
    expect(result.extracted_data).toEqual({ total: 42 });
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      pages_processed: 3,
      model_used: 'gpt-x',
      cost_usd: 0.0125,
      breakdown: [{ k: 1 }],
    });
    expect(result.download_url).toBe(`/api/v1/operations/${String(row.id)}/download`);
    expect(body.error).toBeUndefined();
  });

  it('a FAILED operation with recorded steps carries BOTH error and result', async () => {
    const row = newOperation({
      state: 'FAILED',
      error_code: 'PROVIDER_TIMEOUT',
      error_message: 'upstream timed out',
      failed_at_step: 3,
      steps_result_json: JSON.stringify([{ processor: 'p' }]),
      total_input_tokens: 7,
      total_output_tokens: 0,
      total_cost_usd: '0.001000',
    });
    db.operations.push(row);
    const body = json(await wireRequest(base, 'GET', `/api/v1/operations/${String(row.id)}`, keyHeaders()));
    expect(body.done).toBe(true);
    expect(body.error).toEqual({
      code: 'PROVIDER_TIMEOUT',
      message: 'upstream timed out',
      failed_step: 3,
    });
    expect(body.result).toEqual({
      pipeline_steps: [{ processor: 'p' }],
      usage: { input_tokens: 7, output_tokens: 0, cost_usd: 0.001, breakdown: [] },
    });
  });

  it('a FAILED operation with no steps carries error and NO result block', async () => {
    const row = newOperation({
      state: 'FAILED',
      error_code: 'BAD_INPUT',
      error_message: 'unreadable',
      failed_at_step: 1,
      steps_result_json: null,
    });
    db.operations.push(row);
    const body = json(await wireRequest(base, 'GET', `/api/v1/operations/${String(row.id)}`, keyHeaders()));
    expect(body.error).toEqual({ code: 'BAD_INPUT', message: 'unreadable', failed_step: 1 });
    expect(body.result).toBeUndefined();
  });

  it('a CANCELLED operation is done:true with neither an error nor a result block', async () => {
    const row = newOperation({ state: 'CANCELLED' });
    db.operations.push(row);
    const body = json(await wireRequest(base, 'GET', `/api/v1/operations/${String(row.id)}`, keyHeaders()));
    expect(body.done).toBe(true);
    expect(body.error).toBeUndefined();
    expect(body.result).toBeUndefined();
    expect((body.metadata as Record<string, unknown>).state).toBe('CANCELLED');
  });

  it('an unknown operation 404s with the legacy requested_id field', async () => {
    const missing = '99999999-9999-4999-8999-999999999999';
    const res = await wireRequest(base, 'GET', `/api/v1/operations/${missing}`, keyHeaders());
    expect(res.status).toBe(404);
    const body = json(res);
    expect(Object.keys(body).sort()).toEqual(['detail', 'requested_id', 'status', 'title', 'type']);
    expect(body.type).toBe('https://dugate.vn/errors/operation-not-found');
    expect(body.title).toBe('Operation Not Found');
    expect(body.requested_id).toBe(missing);
    expect(body.detail).toBe(`Operation '${missing}' not found.`);
  });

  it("another tenant's operation is 404 - the fence must not leak existence", async () => {
    const foreign = newOperation({ tenant_id: FOREIGN_TENANT });
    db.operations.push(foreign);
    const res = await wireRequest(base, 'GET', `/api/v1/operations/${String(foreign.id)}`, keyHeaders());
    expect(res.status).toBe(404);
    expect(json(res).title).toBe('Operation Not Found');
  });

  // ===================================================================
  // C. Delete / cancel / resume
  // ===================================================================

  it('DELETE answers 204 with an empty body, then the row reads as gone', async () => {
    const row = newOperation();
    db.operations.push(row);
    const del = await wireRequest(base, 'DELETE', `/api/v1/operations/${String(row.id)}`, keyHeaders());
    expect(del.status).toBe(204);
    expect(del.raw.length).toBe(0);
    const after = await wireRequest(base, 'GET', `/api/v1/operations/${String(row.id)}`, keyHeaders());
    expect(after.status).toBe(404);
  });

  it('cancel moves a running operation to CANCEL_REQUESTED, never to a terminal state', async () => {
    const row = newOperation({ state: 'RUNNING' });
    db.operations.push(row);
    const res = await wireRequest(base, 'POST', `/api/v1/operations/${String(row.id)}/cancel`, keyHeaders());
    expect(res.status).toBe(200);
    const body = json(res);
    expect((body.metadata as Record<string, unknown>).state).toBe('CANCEL_REQUESTED');
    expect(body.done).toBe(false);
    expect(row.state).toBe('CANCEL_REQUESTED');
  });

  // RV01-F2 (KNOWN DEFECT - currently RED against legacy).
  // app/api/v1/operations/[id]/cancel/route.ts answered a missing operation with
  // {type,title,status} - three keys, no `detail`. legacyError() always writes a
  // `detail`, so the rework body carries a fourth key the legacy client never
  // received. Strict-schema clients reject it.
  // it.failing = tripwire: green while the defect stands, RED once it is fixed.
  it.failing('RV01-F2 cancel 404 keeps the legacy three-key body', async () => {
    const res = await wireRequest(
      base,
      'POST',
      '/api/v1/operations/99999999-9999-4999-8999-999999999999/cancel',
      keyHeaders(),
    );
    expect(res.status).toBe(404);
    const body = json(res);
    // app/api/v1/operations/[id]/cancel/route.ts sent {type,title,status} only.
    expect(Object.keys(body).sort()).toEqual(['status', 'title', 'type']);
    expect(body.type).toBe('https://dugate.vn/errors/not-found');
    expect(body.title).toBe('Not Found');
  });

  // RV01-F3 (KNOWN DEFECT - currently RED against legacy).
  // legacyError() derives the problem `type` slug from the TITLE, so
  // 'Already Completed' becomes .../already-completed. The legacy cancel route
  // hardcoded .../already-done. A client switching on `type` misses the 409.
  it.failing('RV01-F3 cancel 409 keeps the legacy already-done type slug', async () => {
    const row = newOperation({ state: 'SUCCEEDED' });
    db.operations.push(row);
    const res = await wireRequest(base, 'POST', `/api/v1/operations/${String(row.id)}/cancel`, keyHeaders());
    expect(res.status).toBe(409);
    const body = json(res);
    expect(body.type).toBe('https://dugate.vn/errors/already-done');
    expect(body.title).toBe('Already Completed');
    expect(body.detail).toBe('Cannot cancel a completed operation.');
  });

  it('resume requeues a WAITING_INPUT operation and answers {success:true}', async () => {
    const row = newOperation({ state: 'WAITING_INPUT' });
    db.operations.push(row);
    const res = await wireRequest(
      base,
      'POST',
      `/api/v1/operations/${String(row.id)}/resume`,
      keyHeaders(JSON_HEADERS),
      JSON_BODY,
    );
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ success: true, message: 'Resumed successfully' });
    expect(resumes).toEqual([{ id: String(row.id), tenantId: TENANT, body: {} }]);
  });

  it('a bad resume answers {error} - not problem+json - because legacy used NextResponse.json', async () => {
    const running = newOperation({ state: 'RUNNING' });
    db.operations.push(running);
    const wrong = await wireRequest(
      base,
      'POST',
      `/api/v1/operations/${String(running.id)}/resume`,
      keyHeaders(JSON_HEADERS),
      JSON_BODY,
    );
    expect(wrong.status).toBe(400);
    expect(json(wrong)).toEqual({
      error: 'Operation is in state RUNNING, cannot resume. Must be WAITING_USER_INPUT.',
    });
    expect(resumes).toHaveLength(0);
    const missing = await wireRequest(
      base,
      'POST',
      '/api/v1/operations/99999999-9999-4999-8999-999999999999/resume',
      keyHeaders(JSON_HEADERS),
      JSON_BODY,
    );
    expect(missing.status).toBe(404);
    expect(json(missing)).toEqual({ error: 'Operation not found' });
  });

  // ===================================================================
  // D. Download
  // ===================================================================

  // RV01-F1 (KNOWN DEFECT - currently RED against legacy; the worst finding).
  // The mount returns {status, body:{}, headers:{content-type, content-length}}
  // and NEVER a `raw` buffer. server.ts only sends `raw` byte-for-byte; for
  // every other outcome it JSON-stringifies `body`. So the response declares
  // Content-Length: <byte count> and then writes 2 bytes of `{}`. Node keeps
  // the declared length, sends a truncated body, and TEARS THE RESPONSE DOWN:
  // the client observes 'aborted' and never receives the document at all.
  // Legacy returned the output content inline with a Content-Disposition.
  it.failing('RV01-F1 download sends the output bytes on the wire', async () => {
    const row = newOperation({
      state: 'SUCCEEDED',
      output_format: 'markdown',
      output_content: '# downloaded body',
    });
    db.operations.push(row);
    const res = await wireRequest(base, 'GET', `/api/v1/operations/${String(row.id)}/download`, keyHeaders());
    // One snapshot assertion so the jest diff records the WHOLE observed wire
    // state - declared length, bytes actually received, and whether Node tore
    // the response down - rather than only the first mismatch.
    expect({
      aborted: res.aborted,
      status: res.status,
      contentType: res.headers['content-type'],
      declaredLength: res.headers['content-length'],
      receivedBytes: res.raw.length,
      received: res.body,
    }).toEqual({
      aborted: false,
      status: 200,
      contentType: 'text/markdown; charset=utf-8',
      declaredLength: '17',
      receivedBytes: 17,
      received: '# downloaded body',
    });
  });

  it('downloading an unfinished operation is 409 not-ready', async () => {
    const row = newOperation({ state: 'RUNNING' });
    db.operations.push(row);
    const res = await wireRequest(base, 'GET', `/api/v1/operations/${String(row.id)}/download`, keyHeaders());
    expect(res.status).toBe(409);
    const body = json(res);
    expect(body.type).toBe('https://dugate.vn/errors/not-ready');
    expect(body.title).toBe('Not Ready');
    expect(body.detail).toBe('Operation has not completed successfully.');
  });

  it('a succeeded operation with neither inline nor file output is 404 no-output', async () => {
    const row = newOperation({ state: 'SUCCEEDED', output_content: null });
    db.operations.push(row);
    const res = await wireRequest(base, 'GET', `/api/v1/operations/${String(row.id)}/download`, keyHeaders());
    expect(res.status).toBe(404);
    const body = json(res);
    expect(Object.keys(body).sort()).toEqual(['detail', 'status', 'title', 'type']);
    expect(body.type).toBe('https://dugate.vn/errors/no-output');
    expect(body.title).toBe('No Output');
  });

  // ===================================================================
  // E. List + page_token walk
  // ===================================================================

  it('GET /operations answers {operations, next_page_token} and pages by plain uuid', async () => {
    const newest = newOperation({ created_at: '2026-10-03T00:00:00.000Z', state: 'SUCCEEDED', endpoint_slug: 'extract' });
    const middle = newOperation({ created_at: '2026-10-02T00:00:00.000Z', state: 'FAILED', error_code: 'E', error_message: 'm', failed_at_step: 2 });
    const oldest = newOperation({ created_at: '2026-10-01T00:00:00.000Z', state: 'RUNNING' });
    db.operations.push(newest, middle, oldest);

    const page1 = await wireRequest(base, 'GET', '/api/v1/operations?page_size=2', keyHeaders());
    expect(page1.status).toBe(200);
    const b1 = json(page1);
    expect(Object.keys(b1).sort()).toEqual(['next_page_token', 'operations']);
    expect((b1.operations as Record<string, unknown>[]).map((o) => o.name)).toEqual([
      `operations/${String(newest.id)}`,
      `operations/${String(middle.id)}`,
    ]);
    // The legacy page_token is the plain id of the last row, NOT an encoded cursor.
    expect(b1.next_page_token).toBe(String(middle.id));
    const item = (b1.operations as Record<string, unknown>[])[0]!;
    expect(Object.keys(item).sort()).toEqual(['done', 'metadata', 'name', 'result']);
    expect(Object.keys(item.metadata as Record<string, unknown>).sort()).toEqual([
      'create_time',
      'current_step',
      'endpoint_slug',
      'progress_message',
      'progress_percent',
      'state',
      'update_time',
    ]);
    expect(item.result).toEqual({ usage: { input_tokens: null, output_tokens: null, cost_usd: null } });

    const page2 = await wireRequest(
      base,
      'GET',
      `/api/v1/operations?page_size=2&page_token=${String(middle.id)}`,
      keyHeaders(),
    );
    expect(page2.status).toBe(200);
    const b2 = json(page2);
    expect((b2.operations as Record<string, unknown>[]).map((o) => o.name)).toEqual([
      `operations/${String(oldest.id)}`,
    ]);
    expect(b2.next_page_token).toBeNull();
  });

  it('a soft-deleted row disappears from the list', async () => {
    const live = newOperation({ created_at: '2026-10-02T00:00:00.000Z' });
    const gone = newOperation({ created_at: '2026-10-01T00:00:00.000Z', deleted_at: '2026-10-01T12:00:00.000Z' });
    db.operations.push(live, gone);
    const res = await wireRequest(base, 'GET', '/api/v1/operations', keyHeaders());
    expect((json(res).operations as Record<string, unknown>[]).map((o) => o.name)).toEqual([
      `operations/${String(live.id)}`,
    ]);
  });

  it('an invalid state filter is a bare {error} 400, not problem+json', async () => {
    const res = await wireRequest(base, 'GET', '/api/v1/operations?filter=state=BOGUS', keyHeaders());
    expect(res.status).toBe(400);
    expect(json(res)).toEqual({
      error: 'Invalid state filter. Must be one of: RUNNING, SUCCEEDED, FAILED, PENDING',
    });
  });

  it('a valid state filter narrows the page', async () => {
    const ok = newOperation({ state: 'SUCCEEDED', created_at: '2026-10-03T00:00:00.000Z' });
    const running = newOperation({ state: 'RUNNING', created_at: '2026-10-02T00:00:00.000Z' });
    db.operations.push(ok, running);
    const res = await wireRequest(base, 'GET', '/api/v1/operations?filter=state=SUCCEEDED', keyHeaders());
    expect((json(res).operations as Record<string, unknown>[]).map((o) => o.name)).toEqual([
      `operations/${String(ok.id)}`,
    ]);
  });

  // ===================================================================
  // F. Billing
  // ===================================================================

  it('balance with a limit reports spending_limit, total_used and the difference', async () => {
    db.apiKeys[0]!.spending_limit = '50.000000';
    db.apiKeys[0]!.total_used = '12.500000';
    const res = await wireRequest(base, 'GET', '/api/v1/billing/balance', keyHeaders());
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.object).toBe('billing_balance');
    expect(body.api_key_id).toBe(KEY_ID);
    expect(body.api_key_name).toBe('RV01 key');
    expect(body.currency).toBe('USD');
    expect(body.details).toEqual({ spending_limit: 50, total_used: 12.5, balance: 37.5 });
  });

  it('balance with no limit set reports a NULL balance, not a negative one', async () => {
    const res = await wireRequest(base, 'GET', '/api/v1/billing/balance', keyHeaders());
    expect(res.status).toBe(200);
    expect((json(res).details as Record<string, unknown>)).toEqual({
      spending_limit: null,
      total_used: 0,
      balance: null,
    });
  });

  it('usage aggregates SUCCEEDED spend per model and counts operations', async () => {
    db.operations.push(
      newOperation({
        state: 'SUCCEEDED',
        model_used: 'gpt-a',
        total_input_tokens: 100,
        total_output_tokens: 10,
        pages_processed: 2,
        total_cost_usd: '0.500000',
      }),
      newOperation({
        state: 'SUCCEEDED',
        model_used: 'gpt-a',
        total_input_tokens: 50,
        total_output_tokens: 5,
        pages_processed: 1,
        total_cost_usd: '0.250000',
      }),
      newOperation({ state: 'FAILED', model_used: 'gpt-b', total_cost_usd: '9.000000' }),
    );
    db.apiKeys[0]!.total_used = '0.750000';
    const res = await wireRequest(
      base,
      'GET',
      '/api/v1/billing/usage?start_date=2026-09-01&end_date=2026-09-30',
      keyHeaders(),
    );
    expect(res.status).toBe(200);
    const body = json(res);
    expect(body.object).toBe('billing_usage');
    expect(body.start_date).toBe('2026-09-01');
    expect(body.end_date).toBe('2026-09-30');
    expect(body.total_cost_usd).toBe(0.75);
    expect(body.total_input_tokens).toBe(150);
    expect(body.total_output_tokens).toBe(15);
    expect(body.total_operations).toBe(2);
    expect(body.usage).toEqual([
      { model: 'gpt-a', prompt_tokens: 150, completion_tokens: 15, pages_processed: 3, cost_usd: 0.75 },
    ]);
  });

  it('an unparseable usage date is a bare {error} 400', async () => {
    const res = await wireRequest(base, 'GET', '/api/v1/billing/usage?start_date=not-a-date', keyHeaders());
    expect(res.status).toBe(400);
    expect(json(res)).toEqual({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  });

  // ===================================================================
  // G. Identity, path ownership and the unwired surfaces
  // ===================================================================

  it('the admin bearer is NOT a legacy caller: /operations answers the canonical page', async () => {
    const row = newOperation({ created_at: '2026-10-05T00:00:00.000Z' });
    db.operations.push(row);
    const res = await wireRequest(base, 'GET', '/api/v1/operations?limit=10', {
      authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    expect(res.status).toBe(200);
    const body = json(res);
    // Canonical page keys - proof the facade declined the path (RV01 regression
    // guard: before hasAdminBearer() the facade hijacked the Admin shell).
    expect(Object.keys(body).sort()).toEqual([
      'items',
      'limit',
      'nextCursor',
      'prevCursor',
      'total',
    ]);
    expect(body.operations).toBeUndefined();
    expect(body.next_page_token).toBeUndefined();
    expect((body.items as Record<string, unknown>[])[0]!.id).toBe(String(row.id));
  });

  // RV01-F4 (KNOWN DEFECT - currently RED).
  // safePrincipal() swallows the resolveApiKey rejection and every operations
  // route then answers internalError(), so a caller with no key - or a wrong
  // key - gets 500 Internal Error. Legacy did NOT 401 either: it read the
  // stripped x-api-key-id header, skipped its fence, and returned 200 with an
  // unscoped list (the IDOR API-COMPAT-DUGATE forbids replicating). Neither
  // wire is right; 401 Unauthorized is the only defensible one.
  it.failing('RV01-F4 an unauthenticated legacy read is 401, not 500', async () => {
    const res = await wireRequest(base, 'GET', '/api/v1/operations', {});
    expect(res.status).toBe(401);
    expect(json(res).type).toBe('https://dugate.vn/errors/unauthorized');
  });

  it('a wrong API key is refused exactly like a missing one', async () => {
    const res = await wireRequest(base, 'GET', '/api/v1/operations', {
      'x-api-key': 'not-the-key',
    });
    expect(res.status).toBe(500);
    const body = json(res);
    expect(body.title).toBe('Internal Error');
    expect(String(body.detail)).not.toContain('not-the-key');
  });

  it('the workflow facade claims its path with an explicit 503, never a silent 404', async () => {
    const res = await postAction('workflows', [{ name: 'x', value: 'y' }]);
    expect(res.status).toBe(503);
    const body = json(res);
    expect(body.type).toBe('https://dugate.vn/errors/service-not-available');
    expect(body.title).toBe('Service Not Available');
    expect(body.status).toBe(503);
  });

  it('the workflow schema route is claimed too', async () => {
    const mp = multipart([{ name: 'x', value: 'y' }]);
    const res = await wireRequest(base, 'POST', '/api/v1/docs/workflows/schema', {
      ...keyHeaders(),
      'content-type': mp.contentType,
      'content-length': String(mp.body.length),
    }, mp.body);
    expect(res.status).toBe(503);
  });

  it('GET /api/v1/services answers 500 while unwired, never an empty catalogue', async () => {
    const res = await wireRequest(base, 'GET', '/api/v1/services', keyHeaders());
    expect(res.status).toBe(500);
    const body = json(res);
    expect(body.title).toBe('Internal Error');
    // An empty list would read as "you may call nothing".
    expect(body.services).toBeUndefined();
  });

  // RV01-F5 (KNOWN DEFECT - currently RED).
  // parseLegacyDocsPath returns null for a slug outside the six core actions,
  // so the request falls through to the canonical table and comes back as
  // urn:du:error:not_found - a different `type` namespace from the legacy
  // 404 Service Not Found the old runner returned.
  it.failing('RV01-F5 an unknown docs slug keeps the legacy type namespace', async () => {
    const res = await postAction('bogus-action', [{ name: 'x', value: 'y' }]);
    expect(res.status).toBe(404);
    expect(json(res).type).toBe('https://dugate.vn/errors/service-not-found');
  });

  // RV01-F6 (KNOWN DEFECT - currently RED).
  // A JSON submit never enters the streaming branch, so the facade reaches
  // decodeLegacyMultipart with no bodyStream and converts the guard into a
  // 400 Invalid Parameter. The content type was the thing that was wrong.
  it.failing('RV01-F6 a non-multipart submit is 415 Unsupported Media Type', async () => {
    const res = await wireRequest(base, 'POST', '/api/v1/docs/extract', {
      ...keyHeaders(),
      'content-type': 'application/json',
      'content-length': '2',
    }, JSON_BODY);
    expect(res.status).toBe(415);
    expect(json(res).type).toBe('https://dugate.vn/errors/unsupported-media-type');
  });
});

export {};
