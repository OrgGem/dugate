/**
 * ENC-META-SENTINEL — G2: runtime result/ref columns under the metadata seam.
 *
 * Same gap class as G1, different writers (scan §1.3). Driven through the
 * REAL `createApp` runtime service with a scripted `pg` and the real metadata
 * seam over a reversible fake provider (offline; no PG/Redis/Vault):
 *
 *   1. `tasks.result_ref` / `operations.result_ref` (runtime.ts:545,568) -
 *      a worker-supplied string stored verbatim. FINDING pin (green) plus a
 *      RED detector for the sealed-at-rest property; turning it green is a
 *      contracts + migration decision (a new METADATA_SLOTS entry), not a
 *      one-line fix - recorded, not silently "fixed" here.
 *   2. `human_waits.input_schema` / `ui_schema` / `context_ref`
 *      (runtime.ts:957-970) - schema fields are not in METADATA_SLOTS.
 *      FINDING pin only: whether tenant UI text belongs sealed at rest is a
 *      contracts decision, so no acceptance detector is asserted here.
 *   3. GREEN control: the HITL answer path (response_ref + resume payload_ref
 *      + the resume dispatch row) is sealed and carries no sentinel - the
 *      correct behaviour is demonstrated beside the gaps so a regression in
 *      either direction is visible.
 */
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import {
  contentHash,
  HumanWaitViewSchema,
  OperationViewSchema,
  ResultEnvelopeSchema,
} from '@du/contracts';
import { toOperationView } from '../src/modules/operations/facade';
import { createApp, type App } from '../src/server';
import {
  createMetadataCrypto,
  type MetadataKeyProvider,
} from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { loadMigrationFiles } from '../src/db/migrations';

const KEY_REF = 'enc-meta-sentinel-v1';
const TENANT = 'enc-meta-tenant';
const BUSINESS = 'document-core';
const SENTINEL = 'ENC-META-SENTINEL-REF-4b71';
const HASH = String.fromCharCode(35);

interface ScriptedState {
  queries: string[];
  writes: { sql: string; params: unknown[] }[];
  schemaLedger: { sequence: number; filename: string }[];
  outbox: Record<string, unknown>[];
}

jest.mock('pg', () => {
  const state: ScriptedState = { queries: [], writes: [], schemaLedger: [], outbox: [] };
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string, params: unknown[] = []): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push(text);
    const write = (): PgResult => {
      state.writes.push({ sql: text, params });
      return { rows: [], rowCount: 1 };
    };
    if (text.includes('INSERT INTO human_waits')) return write();
    if (text.includes('INSERT INTO outbox')) {
      state.outbox.push(JSON.parse(String(params[2])) as Record<string, unknown>);
      return write();
    }
    if (text.includes('UPDATE human_waits')) return write();
    // waitInput: existing wait lookup.
    if (/FROM human_waits WHERE task_id=\$1 AND wait_key=\$2/.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    // resumeOperation: the wait under lock.
    if (/FROM human_waits WHERE operation_id=\$1 AND wait_id=\$2 FOR UPDATE/.test(text)) {
      return {
        rows: [{
          id: 'w-1',
          task_id: 'task-1',
          wait_id: 'wait-1',
          input_schema: { type: 'object', additionalProperties: true },
          status: 'OPEN',
        }],
        rowCount: 1,
      };
    }
    // waitInput: task lease check.
    if (/SELECT lease_epoch, state, operation_id FROM tasks WHERE id=\$1 FOR UPDATE/.test(text)) {
      return { rows: [{ lease_epoch: 5, state: 'RUNNING', operation_id: 'op-1' }], rowCount: 1 };
    }
    // completeTask: the lease/identity row.
    if (/SELECT t\.lease_epoch, t\.state, t\.operation_id, o\.tenant_id, o\.business_id/.test(text)) {
      return {
        rows: [{ lease_epoch: 5, state: 'RUNNING', operation_id: 'op-1', tenant_id: TENANT, business_id: BUSINESS, lease_active: true }],
        rowCount: 1,
      };
    }
    // resumeOperation: the task being re-queued.
    if (/SELECT t\.id, t\.state, o\.business_id, o\.business_version, o\.action, o\.correlation_id/.test(text)) {
      return {
        rows: [{
          id: 'task-1',
          state: 'WAITING_INPUT',
          business_id: BUSINESS,
          business_version: '1.0.0',
          action: 'extract',
          correlation_id: 'corr-1',
        }],
        rowCount: 1,
      };
    }
    if (/SELECT parent_id, join_policy FROM task_dependencies/.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT 1 FROM task_dependencies/.test(text)) return { rows: [], rowCount: 0 };
    // resumeOperation: the state bump must return a row.
    if (/UPDATE operations SET state='QUEUED', state_version = state_version \+ 1/.test(text)) {
      return { rows: [{ state: 'QUEUED', state_version: 3 }], rowCount: 1 };
    }
    if (/UPDATE operations SET state='SUCCEEDED'/.test(text)) return write();
    if (/UPDATE operations SET state='WAITING_INPUT'/.test(text)) return write();
    if (text.includes('UPDATE tasks')) return write();
    // maybeScheduleWebhook probe: a null callback returns early.
    if (/callback_url/.test(text)) {
      return {
        rows: [{ id: 'op-1', tenant_id: TENANT, state: 'SUCCEEDED', state_version: 1, callback_url: null, updated_at: new Date(0).toISOString() }],
        rowCount: 1,
      };
    }
    // resumeOperation: the operation under lock.
    if (/SELECT id, tenant_id, state, state_version FROM operations WHERE id=\$1 FOR UPDATE/.test(text)) {
      return { rows: [{ id: 'op-1', tenant_id: TENANT, state: 'WAITING_INPUT', state_version: 2 }], rowCount: 1 };
    }
    if (/FROM operations WHERE id=\$1/i.test(text)) return { rows: [], rowCount: 0 };
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    // MIGRATION-VERIFY-TRAP-FIX: verifyMigrations cross-checks the ledger read
    // against an independent count. Answered BEFORE the row branch below, which
    // would otherwise hand back the whole ledger for a count query.
    if (/count\(\*\)::int/i.test(text) && /schema_migrations/i.test(text)) {
      return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 };
    }
    if (/FROM schema_migrations/i.test(text)) {
      return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    }
    return { rows: [], rowCount: 0 };
  }
  class ScriptedPool {
    async query(sql: string, params: unknown[] = []): Promise<PgResult> {
      return answer(sql, params);
    }
    async connect(): Promise<{
      query: (sql: string, params?: unknown[]) => Promise<PgResult>;
      release: () => void;
    }> {
      return { query: (sql, params = []) => Promise.resolve(answer(sql, params)), release: () => undefined };
    }
    async end(): Promise<void> {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

function scripted(): ScriptedState {
  return (jest.requireMock('pg') as { __duState: ScriptedState }).__duState;
}

/* Reversible Vault Transit stand-in (same shape as the crx01 seam suites). */
function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'enc-meta-double').update(seed + ':' + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}
function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  }
  return out;
}
function makeKeyProvider(): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(
          Buffer.from(input.dek),
          keystream(input.keyRef + HASH + version, input.dek.length),
        ).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + HASH + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
      return wrapped;
    },
  };
}

/** The sentinel must not survive anywhere in a bound value (incl. base64). */
function leaksSentinel(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') {
    if (value.includes(SENTINEL)) return true;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 8) {
      try {
        return Buffer.from(value, 'base64').toString('utf8').includes(SENTINEL);
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

const RESULT_REF = JSON.stringify({ note: SENTINEL });
const RESULT_HASH = contentHash(RESULT_REF);

async function boot(): Promise<App> {
  return createApp({
    port: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_enc_meta_refs',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'enc-meta-admin-token',
    autoDispatch: false,
    autoMigrate: false,
    metadataEncryption: { keyProvider: makeKeyProvider(), keyRef: KEY_REF },
  });
}

function openCrypto(provider: KeyProvider) {
  return createMetadataCrypto(
    adaptKeyProviderForMetadata(provider) as MetadataKeyProvider,
    KEY_REF,
  );
}

describe('ENC-META-SENTINEL G2: result_ref / human_waits / resume through the real createApp', () => {
  const apps: App[] = [];

  beforeAll(() => {
    scripted().schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map(
      (file) => ({ sequence: file.sequence, filename: file.filename }),
    );
  });

  beforeEach(() => {
    const state = scripted();
    state.writes.length = 0;
    state.queries.length = 0;
    state.outbox.length = 0;
  });

  afterAll(async () => {
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  it('FIX pin (flipped): completeTask SEALS result_ref under BOTH row slots, openable only in its own binding', async () => {
    const provider = makeKeyProvider();
    const app = await boot();
    apps.push(app);

    const ack = await app.runtime.completeTask(
      'task-1',
      { leaseEpoch: 5, resultRef: RESULT_REF, resultHash: RESULT_HASH },
      BUSINESS,
    );
    expect(ack).toMatchObject({ taskId: 'task-1', state: 'SUCCEEDED', replayed: false });

    const taskWrite = scripted().writes.find((w) => w.sql.includes("UPDATE tasks t SET state='SUCCEEDED'"));
    const opWrite = scripted().writes.find((w) => w.sql.includes("UPDATE operations SET state='SUCCEEDED'"));
    expect(taskWrite).toBeDefined();
    expect(opWrite).toBeDefined();
    // ENCMETA-RESULTREF-IMPL: the conscious flip of the old FINDING pin — the
    // stored copies are envelopes now, and the sentinel survives nowhere.
    const taskEnvelope = JSON.parse(String(taskWrite!.params[1])) as Record<string, unknown>;
    const opEnvelope = JSON.parse(String(opWrite!.params[1])) as Record<string, unknown>;
    expect(taskEnvelope).toMatchObject({ version: 1, algorithm: 'aes-256-gcm' });
    expect(opEnvelope).toMatchObject({ version: 1, algorithm: 'aes-256-gcm' });
    expect(leaksSentinel(taskWrite!.params[1])).toBe(false);
    expect(leaksSentinel(opWrite!.params[1])).toBe(false);

    // Positive control: the envelopes really do carry the ref, each under its
    // OWN AAD binding — proving the seal, not a destroyed value.
    const crypto = openCrypto(provider);
    await expect(
      crypto.readStored(taskEnvelope, { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'task-1' }, false),
    ).resolves.toBe(RESULT_REF);
    await expect(
      crypto.readStored(opEnvelope, { tenantId: TENANT, slot: 'operations.result_ref', refId: 'op-1' }, false),
    ).resolves.toBe(RESULT_REF);
  });

  it('RED GAP DETECTOR: result_ref must not rest as plaintext on either row (GREEN since ENCMETA-RESULTREF-IMPL)', async () => {
    const app = await boot();
    apps.push(app);
    await app.runtime.completeTask(
      'task-1',
      { leaseEpoch: 5, resultRef: RESULT_REF, resultHash: RESULT_HASH },
      BUSINESS,
    );

    const taskWrite = scripted().writes.find((w) => w.sql.includes("UPDATE tasks t SET state='SUCCEEDED'"));
    const opWrite = scripted().writes.find((w) => w.sql.includes("UPDATE operations SET state='SUCCEEDED'"));
    // Fails today (finding). Turning it green requires a contracts + migration
    // decision (a METADATA_SLOTS entry for result_ref), not a local edit.
    expect(leaksSentinel(taskWrite!.params[1])).toBe(false);
    expect(leaksSentinel(opWrite!.params[1])).toBe(false);
  });

  it('DOCUMENTED ACCEPTANCE: ui_schema/context_ref rest as plaintext BY EXEMPTION, not as a gap', async () => {
    // ENCMETA-SCHEMA-PREP (2026-10-05) classified both columns; the coordinator
    // approved Option C: KEEP PLAINTEXT, WITH AN EXPLICIT REASON. The reason,
    // measured in that packet:
    //
    //   - `context_ref` has ZERO readers repo-wide and is not a member of
    //     `HumanWaitViewSchema` - it never leaves the database.
    //   - `ui_schema` is read only by two admin view-models that consume a
    //     `wait` projection `toOperationView` never emits - no live consumer.
    //   - Unlike `result_ref` (which HAD a live reader on /result and a RED
    //     detector), neither column has a reader OR a failing assertion.
    //
    // The assertions below are therefore EVIDENCE OF THE EXEMPTION, not a
    // finding to be fixed: they assert the sentinel IS stored, so the day
    // someone seals these columns the test fails and forces a re-decision.
    //
    // CONDITIONAL-ACCEPTANCE TRIGGER: if any future PR projects `wait` /
    // `uiSchema` / `contextRef` onto a public wire, that PR MUST either seal
    // the column (a new METADATA_SLOTS entry) or re-justify this exemption.
    // The wire-boundary guards at the foot of this file are the tripwire.
    const app = await boot();
    apps.push(app);

    const opened = await app.runtime.waitInput('task-1', {
      leaseEpoch: 5,
      waitKey: 'approval',
      inputSchema: { type: 'object', additionalProperties: true },
      uiSchema: { title: `approve ${SENTINEL}` },
      contextRef: `ctx-${SENTINEL}`,
    });
    expect(opened.waitId).toMatch(/^wait_/);

    const waitWrite = scripted().writes.find((w) => w.sql.includes('INSERT INTO human_waits'));
    expect(waitWrite).toBeDefined();
    // [opId, taskId, waitKey, waitId, inputSchema, uiSchema, contextRef, expiresAt]
    expect(leaksSentinel(waitWrite!.params[4])).toBe(false); // structural schema (control, stays unsealed)
    expect(leaksSentinel(waitWrite!.params[5])).toBe(true); // uiSchema: exempt, never projected
    expect(leaksSentinel(waitWrite!.params[6])).toBe(true); // contextRef: exempt, zero readers
  });

  it('GREEN: resumeOperation seals response_ref + resume payload; the dispatch row carries references only', async () => {
    const provider = makeKeyProvider();
    const app = await boot();
    apps.push(app);

    const ack = await app.runtime.resumeOperation('op-1', TENANT, {
      waitId: 'wait-1',
      input: { answer: SENTINEL },
      expectedStateVersion: 2,
    });
    expect(ack).toMatchObject({ operationId: 'op-1', state: 'QUEUED', replayed: false, taskId: 'task-1' });

    const answerWrite = scripted().writes.find((w) => w.sql.includes('UPDATE human_waits'));
    const payloadWrite = scripted().writes.find((w) => w.sql.includes("UPDATE tasks SET state='QUEUED'") && w.sql.includes('payload_ref'));
    expect(answerWrite).toBeDefined();
    expect(payloadWrite).toBeDefined();

    expect(leaksSentinel(answerWrite!.params[1])).toBe(false);
    expect(leaksSentinel(payloadWrite!.params[1])).toBe(false);
    expect(scripted().outbox).toHaveLength(1);
    expect(leaksSentinel(scripted().outbox[0])).toBe(false);

    const crypto = openCrypto(provider);
    const openedAnswer = await crypto.readStored(
      JSON.parse(String(answerWrite!.params[1])),
      { tenantId: TENANT, slot: 'human_waits.response_ref', refId: 'wait-1' },
      false,
    );
    expect(openedAnswer).toMatchObject({ input: { answer: SENTINEL } });
    const openedResume = await crypto.readStored(
      JSON.parse(String(payloadWrite!.params[1])),
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: 'task-1' },
      false,
    );
    expect(openedResume).toEqual({ resumeInput: { answer: SENTINEL }, waitId: 'wait-1' });
  });
});
/**
 * ENCMETA-SCHEMA-IMPL (2026-10-05) - wire-boundary guards for the documented
 * exemption above. Option C keeps `ui_schema`/`context_ref` plaintext at rest.
 * That is defensible ONLY while neither value can cross to a client, so these
 * tests pin the property that protects tenants: the public wire shapes are
 * CLOSED to both fields. Three mechanisms, so no single point of failure:
 *   - `toOperationView` builds neither key;
 *   - `ResultEnvelopeSchema` is `.strict()` => an added key is REJECTED;
 *   - `OperationViewSchema` / `HumanWaitViewSchema` are non-strict => an added
 *     key is STRIPPED (accepted as unknown, never surfaced).
 */
describe('ENCMETA-SCHEMA-IMPL: wire boundary is closed to uiSchema/contextRef', () => {
  const e2eApps: App[] = [];
  afterAll(async () => {
    for (const a of e2eApps) await a.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
  });

  it('toOperationView projects neither uiSchema nor contextRef (nor the sentinel)', () => {
    const view = toOperationView({
      id: '11111111-1111-4111-8111-111111111111',
      tenant_id: TENANT,
      business_id: BUSINESS,
      business_version: '1.0.0',
      action: 'extract',
      state: 'WAITING_INPUT',
      state_version: 2,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      deadline_at: null,
      ui_schema: { title: `approve ${SENTINEL}` },
      context_ref: `ctx-${SENTINEL}`,
    });
    const keys = Object.keys(view);
    expect(keys).not.toContain('uiSchema');
    expect(keys).not.toContain('ui_schema');
    expect(keys).not.toContain('contextRef');
    expect(keys).not.toContain('context_ref');
    expect(JSON.stringify(view)).not.toContain(SENTINEL);
  });

  it('ResultEnvelopeSchema is STRICT: an added uiSchema/contextRef is rejected outright', () => {
    const base = {
      schemaVersion: '1',
      data: {},
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0, costMicrousd: 0, measurement: 'measured' },
      warnings: [],
    };
    expect(ResultEnvelopeSchema.safeParse(base).success).toBe(true);
    expect(ResultEnvelopeSchema.safeParse({ ...base, uiSchema: { t: SENTINEL } }).success).toBe(false);
    expect(ResultEnvelopeSchema.safeParse({ ...base, contextRef: SENTINEL }).success).toBe(false);
  });

  it('OperationViewSchema STRIPS an added uiSchema (accepted as unknown, never surfaced)', () => {
    const parsed = OperationViewSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT,
      businessId: BUSINESS,
      businessVersion: '1.0.0',
      action: 'extract',
      state: 'WAITING_INPUT',
      stateVersion: 2,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      deadlineAt: null,
      progress: { percent: 0, message: 'WAITING_INPUT' },
      links: { self: '/x', result: '/y' },
      uiSchema: { title: `approve ${SENTINEL}` },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).uiSchema).toBeUndefined();
      expect(JSON.stringify(parsed.data)).not.toContain(SENTINEL);
    }
  });

  it('HumanWaitViewSchema drops context_ref: parses without it and strips it when added', () => {
    const base = { waitId: 'wait-1', inputSchema: { type: 'object' }, expiresAt: new Date(0).toISOString() };
    expect(HumanWaitViewSchema.safeParse(base).success).toBe(true);
    const withCtx = HumanWaitViewSchema.safeParse({ ...base, contextRef: `ctx-${SENTINEL}` });
    expect(withCtx.success).toBe(true);
    if (withCtx.success) {
      expect((withCtx.data as Record<string, unknown>).contextRef).toBeUndefined();
    }
  });

  it('END-TO-END: a sentinel written into ui_schema by waitInput never reaches the operation wire', async () => {
    const app = await boot();
    e2eApps.push(app);
    await app.runtime.waitInput('task-1', {
      leaseEpoch: 5,
      waitKey: 'approval',
      inputSchema: { type: 'object', additionalProperties: true },
      uiSchema: { title: `approve ${SENTINEL}` },
      contextRef: `ctx-${SENTINEL}`,
    });
    // The public projector the /operations/:id route serves:
    const view = toOperationView({
      id: '11111111-1111-4111-8111-111111111111',
      tenant_id: TENANT,
      business_id: BUSINESS,
      business_version: '1.0.0',
      action: 'extract',
      state: 'WAITING_INPUT',
      state_version: 2,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      deadline_at: null,
    });
    expect(JSON.stringify(view)).not.toContain(SENTINEL);
    // The consumer schema strips the ref even for a row that carries it.
    const waitView = HumanWaitViewSchema.parse({
      waitId: 'wait-1',
      inputSchema: { type: 'object' },
      uiSchema: { title: `approve ${SENTINEL}` },
      contextRef: `ctx-${SENTINEL}`,
      expiresAt: new Date(0).toISOString(),
    });
    expect((waitView as Record<string, unknown>).contextRef).toBeUndefined();
  });
});

describe('ENCMETA-SCHEMA-IMPL: regression guards - the slot boundary does not move', () => {
  it('the seal map still seals response_ref + payload_ref, and does NOT absorb input_schema/ui_schema/context_ref', async () => {
    const crypto = openCrypto(makeKeyProvider());
    // Sealed slots stay sealed...
    await expect(crypto.seal({ a: 1 }, { tenantId: TENANT, slot: 'human_waits.response_ref', refId: 'w' })).resolves.toBeDefined();
    await expect(crypto.seal({ a: 1 }, { tenantId: TENANT, slot: 'tasks.payload_ref', refId: 'w' })).resolves.toBeDefined();
    // ...and the exempted / structural columns stay OUTSIDE the seal map.
    await expect(crypto.seal({ a: 1 }, { tenantId: TENANT, slot: 'human_waits.input_schema' as never, refId: 'w' })).rejects.toThrow();
    await expect(crypto.seal({ a: 1 }, { tenantId: TENANT, slot: 'human_waits.ui_schema' as never, refId: 'w' })).rejects.toThrow();
    await expect(crypto.seal({ a: 1 }, { tenantId: TENANT, slot: 'human_waits.context_ref' as never, refId: 'w' })).rejects.toThrow();
  });
});
