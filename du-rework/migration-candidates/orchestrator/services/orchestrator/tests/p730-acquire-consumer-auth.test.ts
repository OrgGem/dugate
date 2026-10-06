import type { PinnedSourceStorage, SdkFetcher } from '@du/worker-sdk';
import type { Db } from '../src/db/db';
import {
  createIngestionConsumer,
  type IngestionConsumerOptions,
} from '../src/modules/operations/ingestion-consumer';
import { SourceAuthDeniedError } from '../src/modules/operations/acquisition-ref-resolver';

/**
 * P730-ACQUIRE (W1c) — consumer-level proof of the two load-bearing claims:
 *
 *  1. A typed auth denial escalates the delivery BEFORE any network call: the
 *     injected fetcher observes ZERO invocations, and the terminal FAILED row
 *     carries the denial's code (never a secret, never the URL).
 *  2. A resolved credential actually rides the fetch: the fetcher records the
 *     authorization header for the original URL, while NO other statement in
 *     the whole flow (claim, fence, retry/complete, fail writes) ever sees it.
 *
 * The router is a supervised fake (unrouted statements throw, like the
 * functional suite's) — SQL TEXT semantics are modeled, not PostgreSQL; the
 * full production join stays with the existing url-ingestion functional suite.
 */

const TENANT = '60000000-0000-4000-8000-000000000001';
const OP = '61000000-0000-4000-8000-000000000001';
const TASK = '62000000-0000-4000-8000-000000000001';
const OUTBOX = '64000000-0000-4000-8000-000000000001';
const SOURCE_URL = 'https://files.example/report.pdf';
const TOKEN_SENTINEL = 'sentinel-source-token-42';

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

interface RouterState {
  failTaskParams: unknown[][];
  failOperationParams: unknown[][];
  retryParams: unknown[][];
  completeParams: unknown[][];
}

function makeRouter(): { db: Db; state: RouterState } {
  const state: RouterState = {
    failTaskParams: [],
    failOperationParams: [],
    retryParams: [],
    completeParams: [],
  };
  const query = async (text: string, params: unknown[] = []) => {
    const sql = normalize(text);
    if (sql.includes("payload->>'gate' = 'ingestion'")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: OUTBOX,
            aggregate_id: OP,
            delivery_id: 'aaaaaaaa-0000-4000-8000-000000000001',
            attempts: 0,
            payload: { gate: 'ingestion', operationId: OP, taskId: TASK, sourceUrl: SOURCE_URL, kind: 'root', correlationId: 'corr-1' },
          },
        ],
      };
    }
    if (sql.startsWith('UPDATE outbox SET claim_until = now()')) return { rowCount: 1, rows: [] };
    if (sql === 'SELECT id FROM outbox WHERE id = $1 FOR UPDATE') return { rowCount: 1, rows: [{ id: OUTBOX }] };
    if (sql.includes('FROM tasks t JOIN operations o')) {
      return {
        rowCount: 1,
        rows: [
          {
            taskId: TASK,
            taskState: 'PENDING_INGESTION',
            payloadRef: { input: { text: 'x' }, sourceUrl: SOURCE_URL },
            tenantId: TENANT,
            opState: 'PENDING_INGESTION',
            cancelRequested: false,
          },
        ],
      };
    }
    if (sql.startsWith('UPDATE tasks SET state=\'FAILED\'')) {
      state.failTaskParams.push(params);
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith("UPDATE operations SET state='FAILED'")) {
      state.failOperationParams.push(params);
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('UPDATE outbox SET claim_until = NULL')) {
      state.retryParams.push(params);
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('UPDATE outbox SET dispatched_at = now()')) {
      state.completeParams.push(params);
      return { rowCount: 1, rows: [] };
    }
    // maybeScheduleWebhook's row read: callback_url null → early return, no INSERT.
    if (sql.startsWith('SELECT id, tenant_id, state, state_version, callback_url, updated_at FROM operations WHERE id=$1')) {
      return {
        rowCount: 1,
        rows: [{ id: OP, tenant_id: TENANT, state: 'FAILED', state_version: 2, callback_url: null, updated_at: new Date().toISOString() }],
      };
    }
    throw new Error('unrouted SQL in consumer test: ' + sql.slice(0, 120));
  };
  const db = {
    pool: {} as never,
    query,
    tx: async <T>(fn: (client: { query: typeof query }) => Promise<T>) => fn({ query }),
    close: async () => undefined,
  } as unknown as Db;
  return { db, state };
}

function makeStorage(): PinnedSourceStorage {
  return {
    resolvePinned: async () => null,
    putVerified: async () => {
      throw new Error('storage must never be reached in these cases');
    },
  };
}

describe('P730-ACQUIRE consumer — deny before network, attach on fetch', () => {
  it('a QUERY_AUTH_FORBIDDEN denial escalates with the code and zero fetch calls', async () => {
    const { db, state } = makeRouter();
    const fetcher = jest.fn(async () => new Response('never', { status: 200 })) as unknown as SdkFetcher;
    const resolveSourceAuth = jest.fn(async () => {
      throw new SourceAuthDeniedError(422, 'QUERY_AUTH_FORBIDDEN', 'URL-query credentials are forbidden');
    });
    const consumer = createIngestionConsumer({
      db,
      storage: makeStorage(),
      transfer: { maxBytes: 1024, timeoutMs: 1_000, maxRedirects: 0, fetcher },
      storageBackend: 's3',
      resolveSourceAuth,
    });

    const result = await consumer.runOnce();
    expect(result).toEqual({ claimed: 1, opened: 0, retried: 0, escalated: 1, replayed: 0, skipped: 0, preempted: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolveSourceAuth).toHaveBeenCalledWith({ operationId: OP, tenantId: TENANT });
    expect(state.failTaskParams).toHaveLength(1);
    expect(state.failTaskParams[0]![1]).toBe('QUERY_AUTH_FORBIDDEN');
    expect(state.failOperationParams[0]![1]).toBe('QUERY_AUTH_FORBIDDEN');
    // The denial code is the ONLY thing that left the resolver: no URL, no payload echo.
    expect(JSON.stringify(state)).not.toContain(SOURCE_URL);
  });

  it('a resolved credential rides the fetch header and appears in NO persisted statement', async () => {
    const { db, state } = makeRouter();
    const fetchCalls: { href: string; authorization: string | null }[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ href, authorization: new Headers(init?.headers).get('authorization') });
      throw new Error('socket down'); // transport failure → retry path (no escalate)
    }) as typeof fetch;
    const consumer = createIngestionConsumer({
      db,
      storage: makeStorage(),
      transfer: { maxBytes: 1024, timeoutMs: 1_000, maxRedirects: 0, fetcher },
      storageBackend: 's3',
      resolveSourceAuth: async () => ({ kind: 'bearer', token: TOKEN_SENTINEL }),
    });

    const result = await consumer.runOnce();
    expect(result).toEqual({ claimed: 1, opened: 0, retried: 1, escalated: 0, replayed: 0, skipped: 0, preempted: 0 });
    expect(fetchCalls).toEqual([{ href: SOURCE_URL, authorization: `Bearer ${TOKEN_SENTINEL}` }]);
    expect(state.retryParams).toHaveLength(1);
    expect(state.failTaskParams).toHaveLength(0);
    // The credential never touched a durable statement or an error code.
    expect(JSON.stringify(state)).not.toContain(TOKEN_SENTINEL);
  });

  it('without the resolver seam the consumer keeps the historical unauthenticated fetch', async () => {
    const { db } = makeRouter();
    const fetchCalls: { href: string; authorization: string | null }[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ href, authorization: new Headers(init?.headers).get('authorization') });
      throw new Error('socket down');
    }) as typeof fetch;
    const consumer = createIngestionConsumer({
      db,
      storage: makeStorage(),
      transfer: { maxBytes: 1024, timeoutMs: 1_000, maxRedirects: 0, fetcher },
      storageBackend: 's3',
    });

    const result = await consumer.runOnce();
    expect(result.retried).toBe(1);
    expect(fetchCalls).toEqual([{ href: SOURCE_URL, authorization: null }]);
  });
});
