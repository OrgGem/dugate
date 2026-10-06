import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { createS3SourceAcquisition } from '../src/modules/operations/s3-source';
import type { PinnedSourceStorage, SdkFetcher } from '@du/worker-sdk';
import type { Db } from '../src/db/db';
import {
  createIngestionConsumer,
  IngestionPreemptedError,
  sourceArtifactId,
  sourceStorageKey,
  type IngestionConsumerOptions,
} from '../src/modules/operations/ingestion-consumer';
import { markIngestionReady } from '../src/modules/operations/submission';
import { createS3PinnedSourceStorage } from '../src/modules/operations/ingestion-storage-s3';
import { createDispatcher } from '../src/modules/queue/dispatcher';
import { createRuntimeService } from '../src/modules/runtime/runtime';
import { createMetadataCrypto, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';

/**
 * W-DATA03-CONSUMER-JOIN-1 offline functional suite (Turn 160 audit HIGH 1).
 *
 * This is the production join exercised end-to-end WITHOUT live infra:
 * a gate 'ingestion' outbox row -> consumer claim -> trusted coordinates read
 * back from the DB -> REAL createSourceAcquisitionIngestor + REAL
 * createIngestionTaskHandler + REAL processIngestionTask + REAL
 * markIngestionReady SQL -> private-store version -> READY artifact row ->
 * operation QUEUED / root task READY -> gate 'ready' dispatch row.
 *
 * Only the system boundaries are faked: the database (in-memory SQL router
 * that ENFORCES the WHERE guards and the UNIQUE delivery_id/PK constraints —
 * an unrouted statement throws, so no query can silently no-op), the private
 * object store (versioned in-memory pin port, body streamed chunk by chunk),
 * and the network (the declared fetcher seam of acquireSourceUrl; no sockets).
 * The dispatcher exclusion of ingestion rows is proven behaviorally: the fake
 * router honors the IS DISTINCT FROM predicate the production SQL carries.
 *
 * LIMITATION (honest): SQL text semantics are modeled by the router, not by
 * PostgreSQL. Real-PG proof of the claim/materialize/gate statements needs a
 * live window (see receipt; new live gate for the Tester).
 */

const TENANT = '60000000-0000-4000-8000-000000000001';
const OP = '61000000-0000-4000-8000-000000000001';
const TASK = '62000000-0000-4000-8000-000000000001';
const SOURCE_URL = 'https://example.com/report.pdf';
// Above the 64 KiB stream chunk bound so the streamed (never whole-buffered)
// hand-off to storage moves in more than one chunk and that is witnessed.
const doc = Buffer.from('W-DATA03 consumer fixture payload line.\n'.repeat(2000), 'utf8');
const docSha = createHash('sha256').update(doc).digest('hex');

interface OpRow {
  id: string;
  tenant_id: string;
  state: string;
  state_version: number;
  input_ref: unknown;
  cancel_requested: boolean;
  callback_url: string | null;
  error_code: string | null;
}
interface TaskRow {
  id: string;
  operation_id: string;
  task_key: string;
  state: string;
  payload_ref: unknown;
  error_code: string | null;
  // W-DATA-03-ORCH-VERIFY: lease columns, so "the refused claim took no lease"
  // is asserted against real state instead of a field that does not exist.
  lease_epoch: number;
  lease_expires_at: number | null;
  leased_by: string | null;
  last_delivery_id: string | null;
  attempt: number;
}
interface OutboxRow {
  id: string;
  aggregate_id: string;
  type: string;
  delivery_id: string;
  payload: Record<string, unknown>;
  due_at: number;
  claim_until: number | null;
  dispatched_at: number | null;
  attempts: number;
}
interface ArtifactRow {
  id: string;
  tenant_id: string;
  operation_id: string | null;
  task_id: string | null;
  purpose: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  state: string;
  storage_key: string;
  storage_version_id: string | null;
  storage_backend: string;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

interface HarnessOptions {
  /** Simulate an artifacts INSERT failing (storage up, DB write down). */
  failArtifactInsert?: boolean;
  /**
   * T180-D1 layering probe: a replica B commits its own claim stamp AFTER
   * our in-gate fence passed but BEFORE the gate UPDATE applies — a legal
   * interleaving while the outbox row is not yet row-locked by us. With the
   * FOR UPDATE ownership lock this can no longer cut into the gate tx; the
   * flag now models the ONLY remaining window: between gate commit and the
   * guarded COMPLETE stamp.
   */
  stealAfterGuard?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  const store = {
    ops: new Map<string, OpRow>(),
    tasks: new Map<string, TaskRow>(),
    outbox: [] as OutboxRow[],
    artifacts: new Map<string, ArtifactRow>(),
    log: [] as string[],
  };
  let outboxSeq = 0;

  function result(rows: unknown[]): { command: string; rowCount: number; oid: number; rows: unknown[]; fields: [] } {
    return { command: 'SQL', rowCount: rows.length, oid: 0, rows, fields: [] };
  }

  async function run(sql: string, params: unknown[] = []): Promise<ReturnType<typeof result>> {
    const n = normalize(sql);
    store.log.push(n);
    const now = Date.now();

    if (n.includes("FROM outbox WHERE type = 'task.dispatch'") && n.includes("payload->>'gate' = 'ingestion'")) {
      const rows = store.outbox
        .filter((row) => row.type === 'task.dispatch')
        .filter((row) => row.dispatched_at === null)
        .filter((row) => row.claim_until === null || row.claim_until < now)
        .filter((row) => row.due_at <= now)
        .filter((row) => row.payload.gate === 'ingestion')
        .sort((a, b) => a.due_at - b.due_at)
        .slice(0, Number(params[0] ?? 50))
        .map((row) => ({
          id: row.id, aggregate_id: row.aggregate_id, delivery_id: row.delivery_id,
          attempts: row.attempts, payload: row.payload,
        }));
      return result(rows);
    }
    if (n.includes('UPDATE outbox SET claim_until = now() +') && n.includes('attempts = attempts + 1')) {
      const row = store.outbox.find((candidate) => candidate.id === params[0]);
      if (row) {
        row.claim_until = now + Number(params[1]) * 1000;
        row.attempts += 1;
      }
      return { ...result([]), rowCount: row ? 1 : 0 };
    }
    // T180-D1 fence renew: [id, leaseSeconds, token] - honors the exact
    // guards the SQL carries (token, undispatched, live lease).
    if (n.includes('UPDATE outbox SET claim_until = now() +') && n.includes('attempts = $3')) {
      const row = store.outbox.find((candidate) => candidate.id === params[0]);
      const owns = !!row && row.attempts === Number(params[2]) && row.dispatched_at === null
        && row.claim_until !== null && row.claim_until > now;
      if (row && owns) {
        row.claim_until = now + Number(params[1]) * 1000;
      }
      return { ...result([]), rowCount: owns ? 1 : 0 };
    }
    if (n.includes('UPDATE outbox SET dispatched_at = now(), claim_until = NULL')) {
      // Text-sensitive like the dispatcher routing router in cycle 9: if
      // production ever drops the attempt guard, the fake stops enforcing
      // it too - so a mutation REDS here instead of hiding behind the fake.
      const guarded = n.includes('attempts = $2');
      const row = store.outbox.find((candidate) => candidate.id === params[0]);
      const owns = !!row && (!guarded || row.attempts === Number(params[1]));
      if (row && owns) {
        row.dispatched_at = now;
        row.claim_until = null;
      }
      return { ...result([]), rowCount: owns ? 1 : 0 };
    }
    if (n.includes('UPDATE outbox SET claim_until = NULL, due_at = now() +')) {
      const guarded = n.includes('attempts = $2');
      const row = store.outbox.find((candidate) => candidate.id === params[0]);
      const owns = !!row && (!guarded || row.attempts === Number(params[1]));
      if (row && owns) {
        row.claim_until = null;
        row.due_at = now + Number(params[2]) * 1000;
      }
      return { ...result([]), rowCount: owns ? 1 : 0 };
    }
    if (n.includes('SELECT id FROM outbox WHERE id = $1 FOR UPDATE')) {
      const row = store.outbox.find((candidate) => candidate.id === params[0]);
      return { ...result(row ? [{ id: row.id }] : []), rowCount: row ? 1 : 0 };
    }
    // CRX-01: the gate's bound-read when the metadata seam is configured — it
    // returns the (tenant, root task id) pair the AAD binds, guarded on both
    // rows still being PENDING_INGESTION exactly like the production SQL.
    if (n.includes('SELECT o.tenant_id AS tenant_id, t.id AS task_id')) {
      const op = store.ops.get(String(params[0]));
      const task = [...store.tasks.values()].find(
        (candidate) => candidate.operation_id === params[0] && candidate.task_key === 'root'
      );
      if (!op || !task || op.state !== 'PENDING_INGESTION' || task.state !== 'PENDING_INGESTION') {
        return result([]);
      }
      return result([{ tenant_id: op.tenant_id, task_id: task.id }]);
    }
    if (n.includes('SELECT t.id AS "taskId"')) {
      const task = [...store.tasks.values()].find(
        (candidate) => candidate.operation_id === params[0] && candidate.task_key === 'root'
      );
      if (!task) return result([]);
      const op = store.ops.get(task.operation_id);
      if (!op) return result([]);
      return result([{
        taskId: task.id, taskState: task.state, payloadRef: task.payload_ref,
        tenantId: op.tenant_id, opState: op.state, cancelRequested: op.cancel_requested,
      }]);
    }
    if (n.includes("UPDATE tasks SET state='FAILED', error_code=$2")) {
      let updated = 0;
      for (const task of store.tasks.values()) {
        if (task.operation_id === params[0] && task.task_key === 'root' && task.state === 'PENDING_INGESTION') {
          task.state = 'FAILED';
          task.error_code = String(params[1]);
          updated += 1;
        }
      }
      return { ...result([]), rowCount: updated };
    }
    if (n.includes("UPDATE operations SET state='FAILED', state_version")) {
      const op = store.ops.get(String(params[0]));
      if (op && op.state === 'PENDING_INGESTION') {
        op.state = 'FAILED';
        op.state_version += 1;
        op.error_code = String(params[1]);
        return { ...result([]), rowCount: 1 };
      }
      return result([]);
    }
    if (n.includes('SELECT id, tenant_id, state, state_version, callback_url,')) {
      const op = store.ops.get(String(params[0]));
      if (!op) return result([]);
      return result([{
        id: op.id, tenant_id: op.tenant_id, state: op.state, state_version: op.state_version,
        callback_url: op.callback_url, updated_at: new Date().toISOString(),
      }]);
    }
    if (n.includes('FROM artifacts WHERE tenant_id=$1')) {
      const rows = [...store.artifacts.values()]
        .filter((row) => row.tenant_id === params[0])
        .filter((row) => row.storage_key === params[1])
        .filter((row) => row.storage_version_id === params[2])
        .filter((row) => row.state === 'READY')
        .slice(0, 2);
      return result(rows);
    }
    if (n.includes('FROM artifacts WHERE id=$1')) {
      const hit = store.artifacts.get(String(params[0]));
      return result(hit ? [hit] : []);
    }
    if (n.includes('INSERT INTO artifacts')) {
      if (opts.failArtifactInsert) throw new Error('fixtures: artifact write rejected');
      const id = String(params[0]);
      if (store.artifacts.has(id)) {
        // ON CONFLICT (id) DO NOTHING - the deterministic PK absorbs it.
        return { ...result([]), rowCount: 0 };
      }
      store.artifacts.set(id, {
        id,
        tenant_id: String(params[1]),
        operation_id: String(params[2]),
        task_id: String(params[3]),
        purpose: 'input',
        mime_type: 'application/octet-stream',
        size_bytes: Number(params[4]),
        sha256: String(params[5]),
        state: 'READY',
        storage_key: String(params[7]),
        storage_version_id: String(params[8]),
        storage_backend: String(params[9]),
      });
      return { ...result([]), rowCount: 1 };
    }
    if (n.includes("UPDATE operations SET state='QUEUED', state_version=state_version+1, input_ref=$2, updated_at=now() WHERE id=$1 AND state='PENDING_INGESTION'")) {
      if (opts.stealAfterGuard) {
        opts.stealAfterGuard = false;
        const stolen = store.outbox.find((candidate) => candidate.payload.gate === 'ingestion');
        if (stolen) {
          stolen.attempts += 1;
          stolen.claim_until = now + 60_000;
        }
      }
      const op = store.ops.get(String(params[0]));
      if (op && op.state === 'PENDING_INGESTION') {
        op.state = 'QUEUED';
        op.state_version += 1;
        op.input_ref = params[1];
        return { ...result([]), rowCount: 1 };
      }
      return result([]);
    }
    if (n.includes("UPDATE tasks SET state='READY', payload_ref=$2, updated_at=now() WHERE operation_id=$1 AND task_key='root' AND state='PENDING_INGESTION'")) {
      let updated = 0;
      for (const task of store.tasks.values()) {
        if (task.operation_id === params[0] && task.task_key === 'root' && task.state === 'PENDING_INGESTION') {
          task.state = 'READY';
          task.payload_ref = params[1];
          updated += 1;
        }
      }
      return { ...result([]), rowCount: updated };
    }
    if (n.includes("INSERT INTO outbox (aggregate_id, type, delivery_id, payload) SELECT id, 'task.dispatch', $2, $3 FROM tasks WHERE operation_id=$1 AND task_key='root' AND state='READY'")) {
      const readyTask = [...store.tasks.values()].find(
        (task) => task.operation_id === params[0] && task.task_key === 'root' && task.state === 'READY'
      );
      if (!readyTask) return result([]);
      const deliveryId = String(params[1]);
      if (store.outbox.some((row) => row.delivery_id === deliveryId)) {
        throw new Error('duplicate key value violates unique constraint "outbox_delivery_id_key"');
      }
      outboxSeq += 1;
      store.outbox.push({
        id: 'ob-' + outboxSeq,
        aggregate_id: readyTask.id,
        type: 'task.dispatch',
        delivery_id: deliveryId,
        payload: JSON.parse(String(params[2])) as Record<string, unknown>,
        due_at: now,
        claim_until: null,
        dispatched_at: null,
        attempts: 0,
      });
      return { ...result([]), rowCount: 1 };
    }
    // W-DATA-03-ORCH-VERIFY: the runtime claim SELECT, so a gated (URL-sourced)
    // task can be driven through claimTask itself. op_state is projected ONLY
    // when the production SQL actually selects it, so dropping
    // `o.state AS op_state` turns the claim test red instead of silently
    // disabling the ingestion guard.
    if (n.includes('FROM tasks t') && n.includes('JOIN operations o') && n.includes('FOR UPDATE OF t')) {
      const taskId = String(params[0]);
      const task = store.tasks.get(taskId);
      if (!task) return result([]);
      const op = store.ops.get(task.operation_id);
      const row: Record<string, unknown> = {
        id: task.id,
        operation_id: task.operation_id,
        task_key: task.task_key,
        kind: 'root',
        state: task.state,
        attempt: task.attempt,
        lease_epoch: task.lease_epoch,
        lease_expires_at: task.lease_expires_at,
        leased_by: task.leased_by,
        last_delivery_id: task.last_delivery_id,
        payload_ref: task.payload_ref,
        error_code: task.error_code,
        tenant_id: op?.tenant_id,
        // OpRow carries no business columns; the claim identity is the fixed
        // business this fixture belongs to.
        business_id: 'du-doc',
        business_version: '1.0.0',
        action: 'ingest',
        input_ref: op?.input_ref,
        deadline_at: null,
        manifest_digest: 'sha256:offline',
        profile_id: null,
        profile_revision: 0,
        connector_bindings: {},
        cancel_requested: op?.cancel_requested ?? false,
      };
      if (n.includes('o.state AS op_state')) row.op_state = op?.state;
      return result([row]);
    }
    if (n.includes('SELECT state FROM operations WHERE id=$1')) {
      const op = store.ops.get(String(params[0]));
      return result(op ? [{ state: op.state }] : []);
    }
    if (n.includes('FROM step_checkpoints')) return result([]);
    // W-DATA-03-ORCH-VERIFY: the claim lease UPDATE that claimTask performs
    // when the guard passes. Without this branch, a successful claim test
    // would hit 'unrouted sql' and the test would be vacuous.
    if (n.includes('UPDATE tasks SET lease_epoch=') && n.includes('lease_expires_at=') && n.includes('leased_by=') && n.includes('last_delivery_id=') && n.includes("state='RUNNING'")) {
      const row = store.tasks.get(String(params[0]));
      const expectedEpoch = Number(params[1]);
      const owns = row && row.lease_epoch + 1 === expectedEpoch;
      if (row && owns) {
        row.lease_epoch = expectedEpoch;
        row.lease_expires_at = Number(params[2]);
        row.leased_by = String(params[3]);
        row.last_delivery_id = String(params[4]);
        row.state = 'RUNNING';
        row.attempt += 1;
      }
      return { ...result([]), rowCount: owns ? 1 : 0 };
    }
    // W-DATA-03-ORCH-VERIFY: the companion operation RUNNING transition that
    // claimTask issues after the task is RUNNING. Without this the task row
    // would be RUNNING but the operation would stay PENDING_INGESTION.
    if (n.includes("UPDATE operations SET state='RUNNING'") && n.includes('state_version = state_version + 1')) {
      const op = store.ops.get(String(params[0]));
      if (op && op.state === 'PENDING_INGESTION') {
        op.state = 'RUNNING';
        op.state_version += 1;
      }
      return { ...result([]), rowCount: op?.state === 'RUNNING' ? 1 : 0 };
    }
    // W-DATA-03-ORCH-VERIFY: the claim lease UPDATE that claimTask performs
    // when the guard passes. Without this branch a successful-claim test would
    // hit 'unrouted sql' and prove nothing.
    if (n.includes('UPDATE tasks SET lease_epoch=') && n.includes('leased_by=') && n.includes('last_delivery_id=') && n.includes("state='RUNNING'")) {
      const row = store.tasks.get(String(params[0]));
      const expectedEpoch = Number(params[1]);
      const owns = !!row && row.lease_epoch + 1 === expectedEpoch;
      if (row && owns) {
        row.lease_epoch = expectedEpoch;
        row.lease_expires_at = Number(params[2]);
        row.leased_by = String(params[3]);
        row.last_delivery_id = String(params[4]);
        row.state = 'RUNNING';
        row.attempt += 1;
      }
      return { ...result([]), rowCount: owns ? 1 : 0 };
    }
    // The companion operation RUNNING transition claimTask issues after the
    // task is RUNNING; without it the task would run while its operation stayed
    // PENDING_INGESTION.
    if (n.includes("UPDATE operations SET state='RUNNING'") && n.includes('state_version = state_version + 1')) {
      const op = store.ops.get(String(params[0]));
      if (op && op.state === 'PENDING_INGESTION') {
        op.state = 'RUNNING';
        op.state_version += 1;
      }
      return { ...result([]), rowCount: op && op.state === 'RUNNING' ? 1 : 0 };
    }
    throw new Error('unrouted sql: ' + n.slice(0, 200));
  }

  const db = {
    pool: {} as never,
    query: async (text: string, params?: unknown[]) => run(text, params ?? []),
    tx: async <T,>(fn: (client: never) => Promise<T>) => fn({ query: run } as never),
    close: async () => undefined,
  } as unknown as Db;

  function seedGatedSubmission(sourceUrl: string = SOURCE_URL, taskId: string = TASK) {
    store.ops.set(OP, {
      id: OP, tenant_id: TENANT, state: 'PENDING_INGESTION', state_version: 1,
      input_ref: { url: 'inline-doc' }, cancel_requested: false, callback_url: null, error_code: null,
    });
    store.tasks.set(taskId, {
      id: taskId, operation_id: OP, task_key: 'root', state: 'PENDING_INGESTION',
      payload_ref: { input: { url: 'inline-doc' }, sourceUrl, ingestionState: 'PENDING' },
      error_code: null,
      lease_epoch: 0, lease_expires_at: null, leased_by: null, last_delivery_id: null, attempt: 0,
    });
    outboxSeq += 1;
    const deliveryId = 'dd000000-0000-4000-8000-0000000000' + String(outboxSeq).padStart(2, '0');
    store.outbox.push({
      id: 'ob-' + outboxSeq,
      aggregate_id: taskId,
      type: 'task.dispatch',
      delivery_id: deliveryId,
      payload: {
        contractVersion: '1', deliveryId, taskId, operationId: OP,
        businessId: 'demo', businessVersion: '1.0.0', action: 'ingest',
        kind: 'root', correlationId: 'corr-' + outboxSeq, gate: 'ingestion', sourceUrl,
      },
      due_at: Date.now() - 1,
      claim_until: null,
      dispatched_at: null,
      attempts: 0,
    });
    return deliveryId;
  }

  return { store, db, seedGatedSubmission };
}
/* ---------------- private-store fixture (PinnedSourceStorage) -------------- */

interface StoredVersion {
  storageKey: string;
  versionId: string;
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
  chunks: number;
}

function makeStorageFixture(opts: { disagreeDigest?: boolean } = {}) {
  const versions: StoredVersion[] = [];
  const pins = new Map<string, { storageKey: string; versionId: string; sha256: string; sizeBytes: number }>();
  const counter = { puts: 0, resolves: 0 };
  const storage: PinnedSourceStorage = {
    async putVerified(input) {
      counter.puts += 1;
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const raw of input.body as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        total += chunk.length;
        if (total > input.maxBytes) throw new Error('fixtures: byte cap exceeded');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, total);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const versionId = 'v' + (versions.length + 1);
      versions.push({ storageKey: input.storageKey, versionId, sha256, sizeBytes: total, bytes, chunks: chunks.length });
      const written = {
        storageKey: input.storageKey,
        versionId,
        sha256: opts.disagreeDigest ? 'f'.repeat(64) : sha256,
        sizeBytes: total,
      };
      pins.set(input.storageKey, written);
      return written;
    },
    async resolvePinned(storageKey) {
      counter.resolves += 1;
      const pin = pins.get(storageKey);
      return pin ? { ...pin } : null;
    },
  };
  return { storage, versions, pins, counter };
}

/* ---------------- fetcher fixture (the declared acquisition seam) ---------- */

interface FetchCounter { fetches: number; urls: string[] }

function makeFetcher(policy: { fail?: boolean; status?: number; sendContentLength?: boolean } = {}) {
  const counter: FetchCounter = { fetches: 0, urls: [] };
  const fetcher = (async (input: unknown) => {
    counter.fetches += 1;
    counter.urls.push(String(input));
    if (policy.fail) throw new Error('fixtures: transport exploded');
    if (policy.status !== undefined) {
      return new Response('gone', { status: policy.status }) as unknown as Response;
    }
    const headers: Record<string, string> = { 'content-type': 'application/pdf' };
    if (policy.sendContentLength) headers['content-length'] = String(doc.length);
    return new Response(doc, { status: 200, headers }) as unknown as Response;
  }) as unknown as SdkFetcher;
  return { fetcher, counter };
}

/* ---------------- composition helpers ------------------------------------- */

type Harness = ReturnType<typeof makeHarness>;
type StorageFixture = ReturnType<typeof makeStorageFixture>;
type NetFixture = ReturnType<typeof makeFetcher>;

function makeConsumer(h: Harness, fixture: StorageFixture, net: NetFixture, overrides: Partial<IngestionConsumerOptions> = {}) {
  const kicks: string[] = [];
  const consumer = createIngestionConsumer({
    db: h.db,
    storage: fixture.storage,
    transfer: { maxBytes: 1024 * 1024, timeoutMs: 10_000, idleTimeoutMs: 5_000, fetcher: net.fetcher },
    storageBackend: 's3',
    batch: 5,
    maxAttempts: 3,
    retryBackoffSeconds: 0,
    claimLeaseSeconds: 60,
    pollIntervalMs: 3_600_000,
    onGateOpened: (operationId) => { kicks.push(operationId); },
    ...overrides,
  });
  return { consumer, kicks };
}

/* ---------------- CRX-01 metadata seam fixture ----------------------------- */

const CRX01_KEY_REF = 'crx01-consumer-offline-v1';
const CRX01_SENTINEL = 'CRX01-CONSUMER-SENTINEL-7f3a';
const CRX01_HASH = String.fromCharCode(35);

function crx01Keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'crx01-consumer-double').update(seed + ':' + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}

function crx01Xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  return out;
}

/** Reversible Vault Transit stand-in; `failWrap` models a key-service outage. */
function crx01Provider(opts: { failWrap?: boolean } = {}): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      if (opts.failWrap) throw new Error('vault transit unavailable');
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: crx01Xor(
          Buffer.from(input.dek),
          crx01Keystream(input.keyRef + CRX01_HASH + version, input.dek.length),
        ).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return crx01Xor(raw, crx01Keystream(wrapped.keyRef + CRX01_HASH + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
      return wrapped;
    },
  };
}

function crx01Crypto(provider: KeyProvider = crx01Provider()) {
  return createMetadataCrypto(
    adaptKeyProviderForMetadata(provider) as MetadataKeyProvider,
    CRX01_KEY_REF,
  );
}

/** The sentinel must not survive anywhere in a stored value (incl. base64). */
function leaksSentinel(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') {
    if (value.includes(CRX01_SENTINEL)) return true;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 8) {
      try {
        return Buffer.from(value, 'base64').toString('utf8').includes(CRX01_SENTINEL);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => leaksSentinel(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => leaksSentinel(v, depth + 1));
  }
  return false;
}

function ingestionRow(h: Harness): OutboxRow {
  const row = h.store.outbox.find((candidate) => candidate.payload.gate === 'ingestion');
  if (!row) throw new Error('no ingestion row');
  return row;
}

function readyRows(h: Harness): OutboxRow[] {
  return h.store.outbox.filter((row) => row.payload.gate === 'ready');
}

function parseEnvelope(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error('envelope was not persisted as a JSON string');
  return JSON.parse(value) as Record<string, unknown>;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error('fixtures: ' + what + ' missing');
  return value;
}

/* ======================= tests ======================= */

describe('W-DATA03-CONSUMER-JOIN-1 offline functional', () => {
  it('IAM S3 source -> bounded acquisition -> immutable private artifact -> READY, without HTTP auth or fetch', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const send = jest.fn().mockResolvedValueOnce({ ContentLength: doc.length, ETag: 'etag', VersionId: 'source-v1' })
      .mockResolvedValueOnce({ Body: Readable.from([doc]), ETag: 'etag', VersionId: 'source-v1' });
    const rules = [{ tenantId: TENANT, bucket: 'customer-documents', prefix: 'invoices/', region: 'ap-southeast-1', expectedBucketOwner: '123456789012' }];
    const resolveSourceAuth = jest.fn(async () => { throw new Error('S3 must not resolve HTTP credentials'); });
    const { consumer } = makeConsumer(h, fixture, net, {
      acquireS3FileForTenant: createS3SourceAcquisition(rules, () => ({ send }) as never), resolveSourceAuth,
    });
    h.seedGatedSubmission('s3://customer-documents/invoices/report.pdf');
    await consumer.runOnce();
    expect(h.store.ops.get(OP)?.state).toBe('QUEUED');
    expect(h.store.tasks.get(TASK)?.state).toBe('READY');
    expect([...h.store.artifacts.values()][0]?.sha256).toBe(docSha);
    expect(fixture.versions).toHaveLength(1);
    expect(readyRows(h)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(net.counter.fetches).toBe(0);
    expect(resolveSourceAuth).not.toHaveBeenCalled();
  });
  it('happy path: claim -> real acquire -> real ingestor -> real materialize -> gate opens QUEUED/READY with an artifactId pin', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer, kicks } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();

    const sweep = await consumer.runOnce();
    expect(sweep).toEqual({ claimed: 1, opened: 1, retried: 0, escalated: 0, replayed: 0, skipped: 0, preempted: 0 });

    const op = h.store.ops.get(OP);
    const task = h.store.tasks.get(TASK);
    if (!op || !task) throw new Error('fixture lost its rows');
    expect(op.state).toBe('QUEUED');
    expect(task.state).toBe('READY');
    // The SAME envelope string on both rows (the contract invariant from
    // the pre-contract two-views bug): the claim side cannot resolve
    // differently depending on which row it reads.
    expect(typeof op.input_ref).toBe('string');
    expect(task.payload_ref).toBe(op.input_ref);
    const envelope = parseEnvelope(op.input_ref);
    expect(envelope.url).toBe('inline-doc');
    expect(envelope.__source).toBeUndefined();
    const pin = envelope.source as Record<string, unknown>;
    const artifactIds = [...h.store.artifacts.keys()];
    expect(artifactIds).toHaveLength(1);
    expect(pin).toEqual({
      storageKey: sourceStorageKey(TENANT, OP),
      versionId: 'v1',
      sha256: docSha,
      sizeBytes: doc.length,
      artifactId: artifactIds[0],
    });
    const artifact = h.store.artifacts.get(must(artifactIds[0], 'artifact id'));
    if (!artifact) throw new Error('artifact vanished');
    expect(artifact.purpose).toBe('input');
    expect(artifact.state).toBe('READY');
    expect(artifact.operation_id).toBe(OP);
    expect(artifact.task_id).toBe(TASK);
    expect(artifact.size_bytes).toBe(doc.length);
    expect(artifact.sha256).toBe(docSha);
    expect(artifact.storage_backend).toBe('s3');
    expect(artifactIds[0]).toBe(sourceArtifactId({
      tenantId: TENANT, operationId: OP, storageKey: String(pin.storageKey), versionId: 'v1', sha256: docSha,
    }));
    // Bytes moved as a stream of many chunks, never a whole-object buffer.
    expect(fixture.versions).toHaveLength(1);
    expect(must(fixture.versions[0], 'version').bytes.equals(doc)).toBe(true);
    expect(must(fixture.versions[0], 'version').chunks).toBeGreaterThan(1);
    expect(net.counter.fetches).toBe(1);
    expect(net.counter.urls[0]).toBe(SOURCE_URL);
    expect(fixture.counter.puts).toBe(1);
    expect(ingestionRow(h).dispatched_at).not.toBeNull();
    const ready = readyRows(h);
    expect(ready).toHaveLength(1);
    const readyRow = must(ready[0], 'ready row');
    expect(readyRow.payload.kind).toBe('root');
    expect(readyRow.payload.operationId).toBe(OP);
    expect(readyRow.delivery_id).not.toBe(ingestionRow(h).delivery_id);
    expect(kicks).toEqual([OP]);
  });

  it('replay after success: the second sweep claims nothing (durable dispatched_at)', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    await consumer.runOnce();
    const second = await consumer.runOnce();
    expect(second.claimed).toBe(0);
    expect(net.counter.fetches).toBe(1);
    expect(readyRows(h)).toHaveLength(1);
  });

  it('crash between the gate commit and the completion stamp: replay consumes the row, fetches nothing, writes nothing', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer, kicks } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    await consumer.runOnce();
    // Simulate the crash: undo ONLY the completion stamp.
    ingestionRow(h).dispatched_at = null;
    const before = net.counter.fetches;
    const sweep = await consumer.runOnce();
    expect(sweep).toEqual({ claimed: 1, opened: 0, retried: 0, escalated: 0, replayed: 1, skipped: 0, preempted: 0 });
    expect(net.counter.fetches).toBe(before);
    expect(fixture.counter.puts).toBe(1);
    expect(readyRows(h)).toHaveLength(1);
    expect(kicks).toHaveLength(1);
    expect(ingestionRow(h).dispatched_at).not.toBeNull();
  });

  it('crash after materialize but before the gate: pin answers with zero network, materialize is SELECT-idempotent, artifactId unchanged', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    await consumer.runOnce();
    const artifactId = must([...h.store.artifacts.keys()][0], 'artifact id');
    // Simulate the crash: the gate transaction never committed; the
    // ingestion row is re-armed, the storage pin and artifact row survive.
    const op = h.store.ops.get(OP);
    const task = h.store.tasks.get(TASK);
    if (!op || !task) throw new Error('fixture lost its rows');
    op.state = 'PENDING_INGESTION';
    op.input_ref = { url: 'inline-doc' };
    task.state = 'PENDING_INGESTION';
    task.payload_ref = { input: { url: 'inline-doc' }, sourceUrl: SOURCE_URL, ingestionState: 'PENDING' };
    ingestionRow(h).dispatched_at = null;

    const sweep = await consumer.runOnce();
    expect(sweep.opened).toBe(1);
    // resolvePinned hit: acquisition and versioning never ran a second time.
    expect(net.counter.fetches).toBe(1);
    expect(fixture.counter.puts).toBe(1);
    expect(h.store.artifacts.size).toBe(1);
    const envelope = parseEnvelope(op.input_ref);
    const pin = envelope.source as Record<string, unknown>;
    expect(pin.artifactId).toBe(artifactId);
    expect(pin.sha256).toBe(docSha);
    expect(pin.versionId).toBe('v1');
  });

  it('permanent: non-HTTPS sourceUrl escalates to FAILED with zero network, zero storage, zero gate writes', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission('http://insecure.example.com/x.pdf');
    const sweep = await consumer.runOnce();
    expect(sweep).toEqual({ claimed: 1, opened: 0, retried: 0, escalated: 1, replayed: 0, skipped: 0, preempted: 0 });
    const op = h.store.ops.get(OP);
    const task = h.store.tasks.get(TASK);
    if (!op || !task) throw new Error('fixture lost its rows');
    expect(op.state).toBe('FAILED');
    expect(op.error_code).toBe('INVALID_SCHEMA');
    expect(task.state).toBe('FAILED');
    expect(task.error_code).toBe('INVALID_SCHEMA');
    expect(net.counter.fetches).toBe(0);
    expect(fixture.counter.puts).toBe(0);
    expect(h.store.artifacts.size).toBe(0);
    expect(readyRows(h)).toHaveLength(0);
    expect(ingestionRow(h).dispatched_at).not.toBeNull();
  });

  it('retryable: transport failure re-arms with backoff and escalates only after the attempt budget', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher({ fail: true });
    const { consumer } = makeConsumer(h, fixture, net, { maxAttempts: 3 });
    h.seedGatedSubmission();

    const s1 = await consumer.runOnce();
    expect(s1).toEqual({ claimed: 1, opened: 0, retried: 1, escalated: 0, replayed: 0, skipped: 0, preempted: 0 });
    expect(h.store.ops.get(OP)?.state).toBe('PENDING_INGESTION');
    expect(ingestionRow(h).dispatched_at).toBeNull();
    expect(ingestionRow(h).attempts).toBe(1);

    const s2 = await consumer.runOnce();
    expect(s2.retried).toBe(1);
    expect(ingestionRow(h).attempts).toBe(2);

    const s3 = await consumer.runOnce();
    expect(s3).toEqual({ claimed: 1, opened: 0, retried: 0, escalated: 1, replayed: 0, skipped: 0, preempted: 0 });
    expect(h.store.ops.get(OP)?.state).toBe('FAILED');
    expect(h.store.ops.get(OP)?.error_code).toBe('TRANSPORT_FAILURE');
    expect(h.store.tasks.get(TASK)?.state).toBe('FAILED');
    expect(net.counter.fetches).toBe(3);
    expect(fixture.counter.puts).toBe(0);
    expect(readyRows(h)).toHaveLength(0);

    const s4 = await consumer.runOnce();
    expect(s4.claimed).toBe(0);
  });

  it('retryable: an upstream 404 exhausts into FAILED(SOURCE_REJECTED), never a silent drop', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher({ status: 404 });
    const { consumer } = makeConsumer(h, fixture, net, { maxAttempts: 1 });
    h.seedGatedSubmission();
    await consumer.runOnce();
    expect(h.store.ops.get(OP)?.state).toBe('FAILED');
    expect(h.store.ops.get(OP)?.error_code).toBe('SOURCE_REJECTED');
    expect(h.store.artifacts.size).toBe(0);
  });

  it('fail-closed: storage digest disagreement is PIN_MISMATCH, no artifact row, no gate', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture({ disagreeDigest: true });
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net, { maxAttempts: 1 });
    h.seedGatedSubmission();
    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    expect(h.store.ops.get(OP)?.error_code).toBe('PIN_MISMATCH');
    expect(h.store.artifacts.size).toBe(0);
    expect(fixture.versions).toHaveLength(1);
    expect(readyRows(h)).toHaveLength(0);
    expect(h.store.ops.get(OP)?.input_ref).toEqual({ url: 'inline-doc' });
  });

  it('fail-closed: a refused artifact write is MATERIALIZATION_FAILED; committed bytes stay invisible behind the closed gate', async () => {
    const h = makeHarness({ failArtifactInsert: true });
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net, { maxAttempts: 1 });
    h.seedGatedSubmission();
    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    expect(h.store.ops.get(OP)?.error_code).toBe('MATERIALIZATION_FAILED');
    expect(fixture.counter.puts).toBe(1);
    expect(h.store.artifacts.size).toBe(0);
    expect(readyRows(h)).toHaveLength(0);
    expect(h.store.ops.get(OP)?.input_ref).toEqual({ url: 'inline-doc' });
  });

  it('budget: mid-stream oversize is TOO_LARGE before any storage write', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net, {
      maxAttempts: 1,
      transfer: { maxBytes: 64, timeoutMs: 10_000, idleTimeoutMs: 5_000, fetcher: net.fetcher },
    });
    h.seedGatedSubmission();
    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    expect(h.store.ops.get(OP)?.error_code).toBe('TOO_LARGE');
    expect(net.counter.fetches).toBe(1);
    expect(fixture.counter.puts).toBe(0);
    expect(readyRows(h)).toHaveLength(0);
  });

  it('budget: a declared content-length above maxBytes is refused before the first byte', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher({ sendContentLength: true });
    const { consumer } = makeConsumer(h, fixture, net, {
      maxAttempts: 1,
      transfer: { maxBytes: 64, timeoutMs: 10_000, idleTimeoutMs: 5_000, fetcher: net.fetcher },
    });
    h.seedGatedSubmission();
    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    expect(h.store.ops.get(OP)?.error_code).toBe('TOO_LARGE');
    expect(fixture.counter.puts).toBe(0);
    expect(h.store.tasks.get(TASK)?.state).toBe('FAILED');
  });

  it('cancel: an operation with a cancel signal is never opened; the delivery is consumed visibly', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer, kicks } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    const op = h.store.ops.get(OP);
    if (!op) throw new Error('fixture lost its row');
    op.cancel_requested = true;
    const sweep = await consumer.runOnce();
    expect(sweep).toEqual({ claimed: 1, opened: 0, retried: 0, escalated: 0, replayed: 0, skipped: 1, preempted: 0 });
    expect(net.counter.fetches).toBe(0);
    expect(op.state).toBe('PENDING_INGESTION');
    expect(readyRows(h)).toHaveLength(0);
    expect(kicks).toHaveLength(0);
    expect(ingestionRow(h).dispatched_at).not.toBeNull();
  });

  it('integrity: sourceUrl disagreement between the dispatch pointer and the DB envelope escalates without touching the network', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    const task = h.store.tasks.get(TASK);
    if (!task) throw new Error('fixture lost its row');
    task.payload_ref = { input: { url: 'inline-doc' }, sourceUrl: 'https://other.example.com/x.pdf', ingestionState: 'PENDING' };
    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    expect(h.store.ops.get(OP)?.error_code).toBe('TASK_INVALID');
    expect(net.counter.fetches).toBe(0);
  });

  it('integrity: a dispatch pointing at a non-root taskId escalates TASK_INVALID', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    const row = ingestionRow(h);
    row.payload = { ...row.payload, taskId: '63000000-0000-4000-8000-000000000009' };
    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    expect(h.store.ops.get(OP)?.error_code).toBe('TASK_INVALID');
    expect(net.counter.fetches).toBe(0);
  });

  it('ownership: the consumer claim selects ONLY gate-ingestion rows and leaves others for the dispatcher', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    const extra = must(h.store.outbox[0], 'seed row');
    h.store.outbox.push({
      ...extra, id: 'ob-ready', delivery_id: 'dd-ready',
      payload: { ...extra.payload, deliveryId: 'dd-ready', gate: 'ready' },
    });
    h.store.outbox.push({
      ...extra, id: 'ob-plain', delivery_id: 'dd-plain',
      payload: { contractVersion: '1', deliveryId: 'dd-plain', taskId: TASK, operationId: OP, kind: 'root' },
    });
    // Make every row non-processable via the gate path so the CLAIM set is
    // the only thing observable: op cancelled -> skip (no fetch, no writes).
    const op = h.store.ops.get(OP);
    if (!op) throw new Error('fixture lost its row');
    op.state = 'CANCELLED';
    const sweep = await consumer.runOnce();
    expect(sweep.claimed).toBe(1);
    expect(sweep.skipped).toBe(1);
    expect(h.store.outbox.find((candidate) => candidate.id === 'ob-ready')?.dispatched_at).toBeNull();
    expect(h.store.outbox.find((candidate) => candidate.id === 'ob-plain')?.dispatched_at).toBeNull();
  });

  it('determinism: sourceArtifactId is a stable RFC-4122 v5 over the pin coordinates', () => {
    const base = { tenantId: TENANT, operationId: OP, storageKey: sourceStorageKey(TENANT, OP), versionId: 'v1', sha256: docSha };
    const first = sourceArtifactId(base);
    expect(sourceArtifactId(base)).toBe(first);
    expect(first).toHaveLength(36);
    expect(first.charAt(14)).toBe('5');
    expect(['8', '9', 'a', 'b'].includes(first.charAt(19))).toBe(true);
    expect(sourceArtifactId({ ...base, sha256: 'a'.repeat(64) })).not.toBe(first);
    expect(/^[0-9a-f-]{36}$/.test(first)).toBe(true);
  });

  it('config: a consumer without a positive byte budget refuses to be constructed', () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    expect(() =>
      createIngestionConsumer({ db: h.db, storage: fixture.storage, storageBackend: 's3', transfer: { maxBytes: 0 } })
    ).toThrow(/positive integer/);
  });

  it('dispatcher routing: gate-ingestion rows never reach a business queue; ready/plain rows do', async () => {
    interface Row { id: string; aggregate_id: string; type: string; delivery_id: string; payload: Record<string, unknown>; attempts: number; dispatched_at: number | null }
    const rows: Row[] = [
      { id: 'r1', aggregate_id: TASK, type: 'task.dispatch', delivery_id: 'd1', attempts: 0, dispatched_at: null,
        payload: { deliveryId: 'd1', taskId: TASK, gate: 'ingestion' } },
      { id: 'r2', aggregate_id: TASK, type: 'task.dispatch', delivery_id: 'd2', attempts: 0, dispatched_at: null,
        payload: { deliveryId: 'd2', taskId: TASK, gate: 'ready' } },
      { id: 'r3', aggregate_id: TASK, type: 'task.dispatch', delivery_id: 'd3', attempts: 0, dispatched_at: null,
        payload: { deliveryId: 'd3', taskId: TASK } },
    ];
    const published: Array<Record<string, unknown>> = [];
    function res(rowsOut: unknown[]) { return { command: 'SQL', rowCount: rowsOut.length, oid: 0, rows: rowsOut, fields: [] }; }
    async function run(sql: string, params: unknown[] = []): Promise<ReturnType<typeof res>> {
      const n = normalize(sql);
      if (n.includes('FROM outbox') && n.includes('dispatched_at IS NULL')) {
        // The router mirrors PostgreSQL semantics for exactly this predicate:
        // if the production SQL ever loses the IS DISTINCT FROM ingestion
        // clause the filter stops applying and the ingestion row leaks -
        // the precise red this test must show.
        const filtersGate = n.includes('IS DISTINCT FROM') && n.includes('ingestion');
        const claimedRows = rows.filter((row) => row.dispatched_at === null && (!filtersGate || row.payload.gate !== 'ingestion'));
        return res(claimedRows.map((row) => ({ id: row.id, aggregate_id: row.aggregate_id, type: row.type, delivery_id: row.delivery_id, payload: row.payload, attempts: row.attempts })));
      }
      if (n.includes('SELECT o.business_id, o.business_version, bv.queue FROM tasks t')) {
        return res([{ business_id: 'demo', business_version: '1.0.0', queue: 'du-business-demo-1.0.0' }]);
      }
      if (n.includes('UPDATE outbox SET dispatched_at = now(), claim_until = NULL, attempts = attempts + 1')) {
        const row = rows.find((candidate) => candidate.id === params[0]);
        if (row) row.dispatched_at = Date.now();
        return res([]);
      }
      throw new Error('unrouted sql: ' + n.slice(0, 160));
    }
    const db = {
      pool: {} as never,
      query: async (text: string, params?: unknown[]) => run(text, params ?? []),
      tx: async <T,>(fn: (client: never) => Promise<T>) => fn({ query: run } as never),
      close: async () => undefined,
    } as unknown as Db;
    const queue = { add: async (_name: string, payload: Record<string, unknown>) => { published.push(payload); return {} as never; } };
    const dispatcher = createDispatcher({ db, getQueue: () => queue as never });
    const dispatched = await dispatcher.dispatchOnce();
    expect(dispatched).toBe(2);
    expect(published.map((payload) => payload.deliveryId)).toEqual(['d2', 'd3']);
    expect(must(rows.find((row) => row.id === 'r1'), 'r1').dispatched_at).toBeNull();
  });

  /* --------------- W-INGEST-POST-LEASE-FENCE-1 (T180-D1 / T180-D2) --------- */

  it('T180-D1: replica losing the claim mid-download writes NOTHING terminal; the newer live claim survives untouched', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    let stolen = false;
    const hijacked: SdkFetcher = (async (input: Parameters<SdkFetcher>[0], init?: Parameters<SdkFetcher>[1]) => {
      const res = await net.fetcher(input, init);
      if (!stolen) {
        stolen = true;
        // Replica B reclaims while A is still inside its first run with
        // token = pre-steal attempts + 1: attempts bumps, lease renews.
        const row = ingestionRow(h);
        row.attempts += 1;
        row.claim_until = Date.now() + 60_000;
      }
      return res;
    }) as unknown as SdkFetcher;
    const consumer = createIngestionConsumer({
      db: h.db,
      storage: fixture.storage,
      transfer: { maxBytes: 1024 * 1024, timeoutMs: 10_000, idleTimeoutMs: 5_000, fetcher: hijacked },
      storageBackend: 's3',
      batch: 5, maxAttempts: 3, retryBackoffSeconds: 0, claimLeaseSeconds: 60,
      pollIntervalMs: 3_600_000,
    });
    h.seedGatedSubmission();
    const sweep = await consumer.runOnce();
    expect(sweep).toEqual({ claimed: 1, opened: 0, retried: 0, escalated: 0, replayed: 0, skipped: 0, preempted: 1 });
    // The download and the pin happened (side effects are idempotent by
    // construction); NOTHING terminal did.
    expect(net.counter.fetches).toBe(1);
    expect(fixture.counter.puts).toBe(1);
    expect(h.store.artifacts.size).toBe(0);
    expect(h.store.ops.get(OP)?.state).toBe('PENDING_INGESTION');
    expect(h.store.tasks.get(TASK)?.state).toBe('PENDING_INGESTION');
    expect(readyRows(h)).toHaveLength(0);
    const row = ingestionRow(h);
    expect(row.dispatched_at).toBeNull();
    expect(row.attempts).toBe(2);
    expect(row.claim_until ?? 0).toBeGreaterThan(Date.now());
  });

  it('T180-D1: a stale RETRY cannot re-arm the newer owner row (no due_at or claim_until clobber)', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const hijacked: SdkFetcher = (async () => {
      const row = ingestionRow(h);
      row.attempts += 1;
      row.claim_until = Date.now() + 60_000;
      throw new Error('fixtures: transport exploded');
    }) as unknown as SdkFetcher;
    const consumer = createIngestionConsumer({
      db: h.db,
      storage: fixture.storage,
      transfer: { maxBytes: 1024 * 1024, timeoutMs: 10_000, idleTimeoutMs: 5_000, fetcher: hijacked },
      storageBackend: 's3',
      batch: 5, maxAttempts: 5, retryBackoffSeconds: 0, claimLeaseSeconds: 60,
      pollIntervalMs: 3_600_000,
    });
    h.seedGatedSubmission();
    const sweep = await consumer.runOnce();
    expect(sweep).toEqual({ claimed: 1, opened: 0, retried: 0, escalated: 0, replayed: 0, skipped: 0, preempted: 1 });
    const row = ingestionRow(h);
    expect(row.attempts).toBe(2);
    expect(row.claim_until ?? 0).toBeGreaterThan(Date.now());
    expect(row.dispatched_at).toBeNull();
  });

  it('T180-D1: a stale escalation must NOT fail the operation the current owner may still open', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const hijacked: SdkFetcher = (async () => {
      const row = ingestionRow(h);
      row.attempts += 1;
      row.claim_until = Date.now() + 60_000;
      throw new Error('fixtures: transport exploded');
    }) as unknown as SdkFetcher;
    const consumer = createIngestionConsumer({
      db: h.db,
      storage: fixture.storage,
      transfer: { maxBytes: 1024 * 1024, timeoutMs: 10_000, idleTimeoutMs: 5_000, fetcher: hijacked },
      storageBackend: 's3',
      batch: 5, maxAttempts: 1, retryBackoffSeconds: 0, claimLeaseSeconds: 60,
      pollIntervalMs: 3_600_000,
    });
    h.seedGatedSubmission();
    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(0);
    expect(sweep.preempted).toBe(1);
    expect(h.store.ops.get(OP)?.state).toBe('PENDING_INGESTION');
    expect(h.store.ops.get(OP)?.error_code).toBeNull();
    expect(h.store.tasks.get(TASK)?.state).toBe('PENDING_INGESTION');
  });

  it('T180-D1 unit: markIngestionReady runs the commit guard INSIDE the tx; when it throws, zero gate statements execute', async () => {
    const statements: string[] = [];
    const client = { query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 }; } };
    const db = { tx: async <T>(fn: (c: unknown) => Promise<T>) => fn(client) } as unknown as Db;
    const guard = async (): Promise<void> => { throw new IngestionPreemptedError(); };
    await expect(markIngestionReady(
      db, OP, { storageKey: 'du/tenants/t/operations/o/source', versionId: 'v1', sha256: 'a'.repeat(64), sizeBytes: 10 },
      { url: 'source' },
      { deliveryId: '7a000000-0000-4000-8000-000000000001', kind: 'root', correlationId: 'fence-001' },
      guard
    )).rejects.toBeInstanceOf(IngestionPreemptedError);
    expect(statements).toHaveLength(0);
  });

  it('T180-D1 config: a claim lease not exceeding the transfer deadline is refused at construction', () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    expect(() => makeConsumer(h, fixture, net, {
      claimLeaseSeconds: 5,
      transfer: { maxBytes: 1024 * 1024, timeoutMs: 10_000, fetcher: net.fetcher },
    })).toThrow(/claimLeaseSeconds must exceed/);
  });

  it('T180-D2 replay: a stored READY row whose digest disagrees with the pin is MATERIALIZATION_CONFLICT, never reused, never overwritten', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    await consumer.runOnce();
    const stored = must([...h.store.artifacts.values()][0], 'artifact');
    stored.sha256 = 'b'.repeat(64);
    const op = h.store.ops.get(OP);
    const task = h.store.tasks.get(TASK);
    if (!op || !task) throw new Error('fixture lost its rows');
    op.state = 'PENDING_INGESTION';
    op.input_ref = { url: 'inline-doc' };
    task.state = 'PENDING_INGESTION';
    task.payload_ref = { input: { url: 'inline-doc' }, sourceUrl: SOURCE_URL, ingestionState: 'PENDING' };
    ingestionRow(h).dispatched_at = null;
    const sweep = await consumer.runOnce();
    expect(sweep.opened).toBe(0);
    expect(sweep.escalated).toBe(1);
    expect(h.store.ops.get(OP)?.state).toBe('FAILED');
    expect(h.store.ops.get(OP)?.error_code).toBe('MATERIALIZATION_CONFLICT');
    expect(h.store.artifacts.size).toBe(1);
    expect(stored.sha256).toBe('b'.repeat(64));
  });

  it('T180-D2 replay: two READY rows for one storage version is a conflict, never an arbitrary pick', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    await consumer.runOnce();
    const stored = must([...h.store.artifacts.values()][0], 'artifact');
    h.store.artifacts.set('65000000-0000-4000-8000-000000000002', {
      ...stored,
      id: '65000000-0000-4000-8000-000000000002',
      sha256: 'c'.repeat(64),
    });
    const op = h.store.ops.get(OP);
    const task = h.store.tasks.get(TASK);
    if (!op || !task) throw new Error('fixture lost its rows');
    op.state = 'PENDING_INGESTION';
    op.input_ref = { url: 'inline-doc' };
    task.state = 'PENDING_INGESTION';
    task.payload_ref = { input: { url: 'inline-doc' }, sourceUrl: SOURCE_URL, ingestionState: 'PENDING' };
    ingestionRow(h).dispatched_at = null;
    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    expect(h.store.ops.get(OP)?.error_code).toBe('MATERIALIZATION_CONFLICT');
  });

  it('T180-D2 PK conflict: the persisted row is RE-READ and verified; a matching one is adopted, id and all', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    h.seedGatedSubmission();
    const expectedId = sourceArtifactId({
      tenantId: TENANT, operationId: OP, storageKey: sourceStorageKey(TENANT, OP), versionId: 'v1', sha256: docSha,
    });
    h.store.artifacts.set(expectedId, {
      id: expectedId,
      tenant_id: TENANT,
      operation_id: OP,
      task_id: TASK,
      purpose: 'input',
      mime_type: 'application/octet-stream',
      size_bytes: doc.length,
      sha256: docSha,
      state: 'READY',
      storage_key: sourceStorageKey(TENANT, OP),
      storage_version_id: 'stale-column',
      storage_backend: 's3',
    });
    const { consumer } = makeConsumer(h, fixture, net);
    const sweep = await consumer.runOnce();
    expect(sweep.opened).toBe(1);
    const envelope = parseEnvelope(h.store.ops.get(OP)?.input_ref);
    const pin = envelope.source as Record<string, unknown>;
    expect(pin.artifactId).toBe(expectedId);
  });
  it('T180-D1 layering: a steal landing between gate commit and the stamp leaves the gate OPEN but the row UN-STAMPED for the newer owner', async () => {
    const h = makeHarness({ stealAfterGuard: true });
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net);
    h.seedGatedSubmission();
    const sweep = await consumer.runOnce();
    // The gate really opened (the in-tx fence passed while we still owned
    // the row):
    expect(sweep.opened).toBe(1);
    expect(h.store.ops.get(OP)?.state).toBe('QUEUED');
    expect(h.store.tasks.get(TASK)?.state).toBe('READY');
    expect(readyRows(h)).toHaveLength(1);
    // ...but the attempt-guarded COMPLETE stamp lost the race, exactly as
    // it must: the row belongs to replica B now and B replay-stamps it.
    const row = ingestionRow(h);
    expect(row.dispatched_at).toBeNull();
    expect(row.attempts).toBe(2);
    // The row stays B's until B's own lease lapses - the fence is bidirec-
    // tional (A could not stamp it, and the sweep cannot double-claim it):
    const idle = await makeConsumer(h, fixture, net).consumer.runOnce();
    expect(idle.claimed).toBe(0);
    // Once B expires without finishing (crash analogue), the next sweep
    // re-claims and the QUEUED/READY state replay-stamps cleanly.
    ingestionRow(h).claim_until = Date.now() - 1;
    const s2 = await makeConsumer(h, fixture, net).consumer.runOnce();
    expect(s2).toEqual({ claimed: 1, opened: 0, retried: 0, escalated: 0, replayed: 1, skipped: 0, preempted: 0 });
    expect(ingestionRow(h).dispatched_at).not.toBeNull();
    expect(readyRows(h)).toHaveLength(1);
  });
  it('s3 pin store: resolvePinned answers the READY artifact row, lowercasing the digest', async () => {
    let seenSql = ''; let seenParams: unknown[] = [];
    const miniDb = {
      query: async (text: string, params?: unknown[]) => {
        seenSql = normalize(text); seenParams = params ?? [];
        return { command: 'SELECT', rowCount: 1, oid: 0, fields: [], rows: [
          { versionId: 'ver-9', sha256: docSha.toUpperCase(), sizeBytes: String(doc.length), id: '64000000-0000-4000-8000-000000000001' },
        ] };
      },
      tx: async <T,>(fn: (client: never) => Promise<T>) => fn(miniDb.query as never),
      pool: {} as never, close: async () => undefined,
    } as unknown as Db;
    const adapter = createS3PinnedSourceStorage({ bucket: 'du-private', send: async () => ({}), db: miniDb });
    const pin = await adapter.resolvePinned('du/tenants/t/operations/o/source');
    expect(seenSql).toContain('FROM artifacts');
    expect(seenSql).toContain('FROM artifacts WHERE storage_key=$1');
    expect(seenParams[0]).toBe('du/tenants/t/operations/o/source');
    expect(pin).toEqual({
      storageKey: 'du/tenants/t/operations/o/source',
      versionId: 'ver-9',
      sha256: docSha,
      sizeBytes: doc.length,
      artifactId: '64000000-0000-4000-8000-000000000001',
    });
  });

  it('s3 pin store: no READY row answers null (a cold key acquires, it does not invent a pin)', async () => {
    const miniDb = {
      query: async () => ({ command: 'SELECT', rowCount: 0, oid: 0, fields: [], rows: [] }),
      tx: async <T,>(fn: (client: never) => Promise<T>) => fn(null as never),
      pool: {} as never, close: async () => undefined,
    } as unknown as Db;
    const adapter = createS3PinnedSourceStorage({ bucket: 'du-private', send: async () => ({}), db: miniDb });
    await expect(adapter.resolvePinned('k')).resolves.toBeNull();
  });

  it('s3 putVerified: streams, measures, and reports the immutable version S3 answered', async () => {
    const { send, commands } = makeFakeS3({ versionId: 'vid-7', checksum: 'ok' });
    const miniDb = { query: async () => ({ command: 'X', rowCount: 0, oid: 0, fields: [], rows: [] }) } as unknown as Db;
    const adapter = createS3PinnedSourceStorage({ bucket: 'du-private', send, db: miniDb });
    const written = await adapter.putVerified({
      storageKey: 'du/tenants/t/operations/o/source',
      contentType: 'application/pdf',
      body: chunkStream(doc, 400),
      maxBytes: 1024 * 1024,
    });
    expect(written).toEqual({
      storageKey: 'du/tenants/t/operations/o/source',
      versionId: 'vid-7',
      sha256: docSha,
      sizeBytes: doc.length,
    });
    const sent = must(commands[0], 's3 command') as { input: Record<string, unknown> };
    expect(sent.input.Bucket).toBe('du-private');
    expect(sent.input.Key).toBe('du/tenants/t/operations/o/source');
  });

  it('s3 putVerified: no immutable VersionId fails closed with STORAGE_FAILURE', async () => {
    const { send } = makeFakeS3({ versionId: null });
    const miniDb = { query: async () => ({ command: 'X', rowCount: 0, oid: 0, fields: [], rows: [] }) } as unknown as Db;
    const adapter = createS3PinnedSourceStorage({ bucket: 'b', send, db: miniDb });
    await expect(adapter.putVerified({ storageKey: 'k', body: chunkStream(doc, 400), maxBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ name: 'SourceIngestionError', code: 'STORAGE_FAILURE' });
  });

  it('s3 putVerified: an S3 checksum that disagrees with the streamed bytes fails closed PIN_MISMATCH', async () => {
    const { send } = makeFakeS3({ versionId: 'vid-8', checksum: 'bad' });
    const miniDb = { query: async () => ({ command: 'X', rowCount: 0, oid: 0, fields: [], rows: [] }) } as unknown as Db;
    const adapter = createS3PinnedSourceStorage({ bucket: 'b', send, db: miniDb });
    await expect(adapter.putVerified({ storageKey: 'k', body: chunkStream(doc, 400), maxBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ name: 'SourceIngestionError', code: 'PIN_MISMATCH' });
  });

  it('s3 putVerified: exceeding the byte budget mid-upload raises TOO_LARGE', async () => {
    const { send } = makeFakeS3({ versionId: 'vid-9', checksum: 'ok' });
    const miniDb = { query: async () => ({ command: 'X', rowCount: 0, oid: 0, fields: [], rows: [] }) } as unknown as Db;
    const adapter = createS3PinnedSourceStorage({ bucket: 'b', send, db: miniDb });
    await expect(adapter.putVerified({ storageKey: 'k', body: chunkStream(doc, 400), maxBytes: 64 }))
      .rejects.toMatchObject({ name: 'SourceIngestionError', code: 'TOO_LARGE' });
  });

  // W-DATA-03-ORCH-VERIFY: "business tasks stay non-runnable until the source
  // artifact reaches READY" is a claim-boundary property, not only a routing
  // one. The dispatcher refuses gate-ingestion rows (proven above), but a task
  // can reach a business queue by any other path; claimTask is the last place
  // that can say no, and it must say no WITHOUT taking a lease.
  it('claim boundary: a PENDING_INGESTION task is refused and takes NO lease', async () => {
    const h = makeHarness();
    h.seedGatedSubmission();
    const runtime = createRuntimeService(h.db);
    await expect(
      runtime.claimTask(TASK, 'delivery-gated-1', 'worker-a-1', 'du-doc'),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    const task = h.store.tasks.get(TASK);
    expect(task?.state).toBe('PENDING_INGESTION');
    expect(task?.lease_epoch ?? 0).toBe(0);
    expect(task?.leased_by ?? null).toBeNull();
  });

  it('claim boundary: once the gate opens, the SAME task claims normally', async () => {
    const h = makeHarness();
    h.seedGatedSubmission();
    // Run the real consumer over the real seeded submission: the gate opens.
    const { consumer } = makeConsumer(h, makeStorageFixture(), makeFetcher());
    const sweep = await consumer.runOnce();
    expect(sweep.opened).toBe(1);
    expect(h.store.ops.get(OP)?.state).toBe('QUEUED');
    expect(h.store.tasks.get(TASK)?.state).toBe('READY');

    // The very same claim that was refused above now succeeds: the guard keys
    // on the gate state, not on the task id.
    const runtime = createRuntimeService(h.db);
    const claimed = await runtime.claimTask(TASK, 'delivery-after-ready-1', 'worker-a-1', 'du-doc');
    expect(claimed.taskId).toBe(TASK);
    expect(claimed.executionSnapshot.tenantId).toBe(TENANT);
    // And the snapshot now carries the materialized pin, not a bare URL. The
    // stored input_ref is the envelope STRING (the same shape the happy-path
    // test pins), so the assertion parses it rather than assuming an object.
    const raw = claimed.executionSnapshot.resolvedInputRef as unknown;
    const envelope = parseEnvelope(raw);
    expect(envelope.source).toBeDefined();
    expect((envelope.source as { artifactId?: string }).artifactId).toBeTruthy();
  });
});

/* ======================= CRX-01: metadata seam at the gate ================= */

describe('CRX-01: the ingestion gate carries the metadata seam end to end', () => {
  it('opens a submit-side sealed payload_ref and writes SEALED READY envelopes; replay rewrites nothing', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const crypto = crx01Crypto();
    const { consumer } = makeConsumer(h, fixture, net, { metadataCrypto: crypto });
    h.seedGatedSubmission();
    const op = must(h.store.ops.get(OP), 'op');
    const task = must(h.store.tasks.get(TASK), 'task');
    // Replace the seeded plaintext rows with the SEALED shapes the submit path
    // actually writes when the seam is on: one envelope per column, each bound
    // to its OWN row identity (operation id / root task id).
    const inbound = {
      input: { url: 'inline-doc', secret: CRX01_SENTINEL },
      sourceUrl: SOURCE_URL,
      ingestionState: 'PENDING',
    };
    op.input_ref = await crypto.seal(
      { url: 'inline-doc', secret: CRX01_SENTINEL },
      { tenantId: TENANT, slot: 'operations.input_ref', refId: OP },
    );
    task.payload_ref = await crypto.seal(
      inbound,
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: TASK },
    );

    const sweep = await consumer.runOnce();
    expect(sweep.opened).toBe(1);
    expect(op.state).toBe('QUEUED');
    expect(task.state).toBe('READY');
    // The gate values are the envelope STRINGS sealSubmitMetadata binds.
    expect(typeof op.input_ref).toBe('string');
    expect(typeof task.payload_ref).toBe('string');
    expect(leaksSentinel(op.input_ref)).toBe(false);
    expect(leaksSentinel(task.payload_ref)).toBe(false);
    const openedInput = await crypto.readStored(
      JSON.parse(String(op.input_ref)),
      { tenantId: TENANT, slot: 'operations.input_ref', refId: OP },
      false,
    );
    const openedPayload = await crypto.readStored(
      JSON.parse(String(task.payload_ref)),
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: TASK },
      false,
    );
    // The contract invariant: the same READY envelope opens from both columns.
    expect(openedInput).toEqual(openedPayload);
    const envelope = openedInput as Record<string, unknown>;
    expect(envelope.url).toBe('inline-doc');
    expect(envelope.secret).toBe(CRX01_SENTINEL); // survives INSIDE the sealed envelope
    expect((envelope.source as { artifactId?: string }).artifactId).toBeTruthy();
    const ready = readyRows(h);
    expect(ready).toHaveLength(1);
    expect(leaksSentinel(must(ready[0], 'ready row').payload)).toBe(false);

    // Replay: the second sweep claims nothing and rewrites neither column.
    const frozen = { input: op.input_ref, payload: task.payload_ref };
    const second = await consumer.runOnce();
    expect(second.claimed).toBe(0);
    expect(op.input_ref).toBe(frozen.input);
    expect(task.payload_ref).toBe(frozen.payload);
    expect(readyRows(h)).toHaveLength(1);
  });

  it('a payload_ref sealed under another row fails closed before the network: TASK_INVALID, gate closed, nothing dispatched', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const crypto = crx01Crypto();
    const { consumer } = makeConsumer(h, fixture, net, { metadataCrypto: crypto, maxAttempts: 1 });
    h.seedGatedSubmission();
    const op = must(h.store.ops.get(OP), 'op');
    const task = must(h.store.tasks.get(TASK), 'task');
    task.payload_ref = await crypto.seal(
      { input: { url: 'inline-doc' }, sourceUrl: SOURCE_URL, ingestionState: 'PENDING' },
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: '63000000-0000-4000-8000-000000000009' },
    );

    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    expect(net.counter.fetches).toBe(0);
    expect(fixture.counter.puts).toBe(0);
    expect(op.state).toBe('FAILED');
    expect(op.error_code).toBe('TASK_INVALID');
    expect(task.state).toBe('FAILED');
    expect(readyRows(h)).toHaveLength(0);
    expect(ingestionRow(h).dispatched_at).not.toBeNull();
  });

  it('a key-service outage at gate-seal time keeps the gate closed and dispatches nothing', async () => {
    const h = makeHarness();
    const fixture = makeStorageFixture();
    const net = makeFetcher();
    const { consumer } = makeConsumer(h, fixture, net, {
      metadataCrypto: crx01Crypto(crx01Provider({ failWrap: true })),
      maxAttempts: 1,
    });
    h.seedGatedSubmission();
    const op = must(h.store.ops.get(OP), 'op');
    const task = must(h.store.tasks.get(TASK), 'task');

    const sweep = await consumer.runOnce();
    expect(sweep.escalated).toBe(1);
    // The acquisition ran (fetch + pin), so the failure is pinned at SEAL time,
    // not earlier: the READY gate never opened, both columns keep the submitted
    // plaintext (the inbound open tolerates the backfill window and never calls
    // Vault), and no business dispatch row was ever written.
    expect(net.counter.fetches).toBe(1);
    expect(fixture.counter.puts).toBe(1);
    expect(op.state).toBe('FAILED');
    expect(task.state).toBe('FAILED');
    expect(op.error_code).toBe('INGESTION_FAILED');
    expect(op.input_ref).toEqual({ url: 'inline-doc' });
    expect(task.payload_ref).toEqual({
      input: { url: 'inline-doc' }, sourceUrl: SOURCE_URL, ingestionState: 'PENDING',
    });
    expect(readyRows(h)).toHaveLength(0);
    expect(ingestionRow(h).dispatched_at).not.toBeNull();
  });
});

/* ---------------- adapter test helpers ------------------------------------ */

function chunkStream(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  return (async function* () {
    for (let offset = 0; offset < bytes.length; offset += size) {
      yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
    }
  })();
}

function makeFakeS3(behavior: { versionId?: string | null; checksum?: 'ok' | 'bad' | 'absent' } = {}) {
  const commands: unknown[] = [];
  const send = async (command: unknown) => {
    commands.push(command);
    const cmd = command as { input: { Body?: AsyncIterable<Uint8Array> } };
    const chunks: Buffer[] = [];
    if (cmd.input.Body) {
      for await (const raw of cmd.input.Body) {
        chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
      }
    }
    const sha = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
    return {
      VersionId: behavior.versionId === null ? undefined : (behavior.versionId ?? 'vid-1'),
      ChecksumSHA256: behavior.checksum === 'absent' || behavior.checksum === undefined
        ? undefined
        : Buffer.from(behavior.checksum === 'bad' ? 'd'.repeat(64) : sha, 'hex').toString('base64'),
    };
  };
  return { send, commands };
}
