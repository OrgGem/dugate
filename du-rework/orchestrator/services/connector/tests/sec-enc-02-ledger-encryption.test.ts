import { randomBytes } from 'node:crypto';
import {
  hashInvocationInput,
  PostgresInvocationLedger,
  type LocalInvocationRequest,
  type NormalizedProviderResult,
  type SqlClient,
} from '../src';
import {
  InvocationFieldCryptoError,
  createInvocationFieldCrypto,
  createLocalInvocationKekProvider,
  parseLocalInvocationKekConfig,
  type InvocationDekKeyProvider,
} from '../src/db/invocation-crypto';

/**
 * SEC-ENC-02 (SD-01) — ledger sealing pins against a recording SQL client.
 *
 * The fake reconstructs `connector_invocations` rows exactly from the SQL
 * parameters the ledger passes, so the assertions inspect what Postgres would
 * actually receive: request/result/session_ref must be v1 envelopes, never
 * plaintext sentinels. Real-PostgreSQL inspection remains the VFY/live gate;
 * this file proves the write path, not a deployed database.
 *
 * Acceptance cells covered:
 *  - seal before SQL, ciphertext-only persisted fields
 *  - replay/get/cancel-compatible reads (opened, unchanged business values)
 *  - restart + key rotation
 *  - wrong tenant/row/slot transplant -> refused
 *  - tamper -> refused
 *  - key outage / no crypto -> no row, no plaintext fallback
 *  - bounded legacy-plaintext read window (explicit opt-in)
 */

const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');
const KEY_REF = 'du-connector-invocation-v1';

function cryptoFixture(keys: Record<string, string> = { '1': KEY_1 }, activeVersion = 1) {
  const parsed = parseLocalInvocationKekConfig(JSON.stringify({ keyRef: KEY_REF, activeVersion, keys }))!;
  return createInvocationFieldCrypto(createLocalInvocationKekProvider(parsed), parsed.keyRef);
}

function makeRequest(invocationId: string, sentinel = 'SENTINEL-CRYPTO'): LocalInvocationRequest {
  return {
    contractVersion: '1',
    invocationId,
    tenantId: 'tenant-a',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: `${sentinel}-PROMPT`, text: `${sentinel}-TEXT` },
    options: { temperature: 0 },
    sessionRef: null,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };
}

interface StoredRow extends Record<string, unknown> {
  invocation_id: string;
  tenant_id: string;
  state: string;
  input_hash: string;
  request: unknown;
  result: unknown;
  session_ref: string | null;
  next_poll_at: string | null;
  poll_lease_token: string | null;
  poll_lease_expires_at: string | null;
  quota_lease_key: string | null;
  quota_lease_id: string | null;
  quota_lease_expires_at: string | null;
  provider_poll_attempts: number;
  provider_request_id: string | null;
}

/** Minimal in-memory Postgres emulation for the ledger's actual statements. */
class FakeInvocationDb implements SqlClient {
  public readonly rows = new Map<string, StoredRow>();
  public readonly calls: Array<{ text: string; parameters?: readonly unknown[] }> = [];
  public insertCount = 0;

  public async query<Row extends object>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number }> {
    const params = parameters ?? [];
    this.calls.push({ text, parameters });
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('SELECT tenant_id FROM connector_invocations')) {
      const row = this.rows.get(String(params[0]));
      return { rows: (row ? [{ tenant_id: row.tenant_id }] : []) as Row[] };
    }
    if (normalized.startsWith('SELECT * FROM connector_invocations')) {
      const row = this.rows.get(String(params[0]));
      return { rows: (row ? [row] : []) as unknown as Row[] };
    }
    if (normalized.startsWith('INSERT INTO connector_invocations')) {
      this.insertCount += 1;
      const id = String(params[0]);
      if (this.rows.has(id)) return { rows: [] as Row[] };
      const row: StoredRow = {
        invocation_id: id,
        tenant_id: String(params[1]),
        operation_id: String(params[2]),
        task_id: String(params[3]),
        step_key: String(params[4]),
        input_hash: String(params[5]),
        request: JSON.parse(String(params[6])),
        state: 'IN_FLIGHT',
        result: null,
        error_code: null,
        provider_request_id: null,
        session_ref: null,
        next_poll_at: null,
        poll_lease_token: null,
        poll_lease_expires_at: null,
        quota_lease_key: null,
        quota_lease_id: null,
        quota_lease_expires_at: null,
        provider_poll_attempts: 0,
        updated_at: new Date().toISOString(),
      };
      this.rows.set(id, row);
      return { rows: [row] as unknown as Row[] };
    }
    if (normalized.startsWith("UPDATE connector_invocations SET state = 'SUCCEEDED'")) {
      const row = this.rows.get(String(params[0]));
      if (!row) return { rows: [] as Row[] };
      const token = params[3] === undefined ? null : String(params[3]);
      const claimable = token === null
        ? row.state === 'IN_FLIGHT'
        : row.state === 'POLLING' && row.poll_lease_token === token;
      if (!claimable) return { rows: [] as Row[] };
      row.result = JSON.parse(String(params[1]));
      row.provider_request_id = (params[2] as string | null) ?? null;
      row.state = 'SUCCEEDED';
      row.poll_lease_token = null;
      row.poll_lease_expires_at = null;
      row.quota_lease_key = null;
      row.quota_lease_id = null;
      row.quota_lease_expires_at = null;
      row.updated_at = new Date().toISOString();
      return { rows: [row] as unknown as Row[] };
    }
    if (normalized.startsWith("UPDATE connector_invocations SET state = 'POLLING'")) {
      const row = this.rows.get(String(params[0]));
      if (!row) return { rows: [] as Row[] };
      const nowMs = Date.parse(String(params[2]));
      const pendingDue = row.state === 'PENDING'
        && row.next_poll_at !== null
        && Date.parse(row.next_poll_at) <= nowMs;
      const leaseExpired = row.state === 'POLLING'
        && row.poll_lease_token !== null
        && row.poll_lease_expires_at !== null
        && Date.parse(row.poll_lease_expires_at) <= nowMs;
      if (!pendingDue && !leaseExpired) return { rows: [] as Row[] };
      row.state = 'POLLING';
      row.poll_lease_token = String(params[3]);
      row.poll_lease_expires_at = new Date(nowMs + Number(params[4])).toISOString();
      return { rows: [{ poll_lease_token: row.poll_lease_token }] as unknown as Row[] };
    }
    if (normalized.startsWith("UPDATE connector_invocations SET state = 'CANCELLED'")) {
      const row = this.rows.get(String(params[0]));
      if (!row || !['IN_FLIGHT', 'PENDING', 'POLLING'].includes(row.state)) return { rows: [] as Row[] };
      row.state = 'CANCELLED';
      row.error_code = 'CANCELLED';
      row.poll_lease_token = null;
      row.poll_lease_expires_at = null;
      row.quota_lease_key = null;
      row.quota_lease_id = null;
      row.quota_lease_expires_at = null;
      row.updated_at = new Date().toISOString();
      return { rows: [row] as unknown as Row[] };
    }
    if (normalized.startsWith("UPDATE connector_invocations SET state = 'PENDING'")) {
      const row = this.rows.get(String(params[0]));
      if (!row) return { rows: [] as Row[] };
      const token = params[3];
      const claimable = token === null || token === undefined
        ? row.state === 'IN_FLIGHT'
        : row.state === 'POLLING' && row.poll_lease_token === token;
      if (!claimable) return { rows: [] as Row[] };
      row.state = 'PENDING';
      row.next_poll_at = String(params[1]);
      row.provider_request_id = (params[2] as string | null) ?? row.provider_request_id;
      row.session_ref = (params[8] as string | null) ?? row.session_ref;
      row.poll_lease_token = null;
      row.poll_lease_expires_at = null;
      row.quota_lease_key = (params[4] as string | null) ?? row.quota_lease_key;
      row.quota_lease_id = (params[5] as string | null) ?? row.quota_lease_id;
      row.quota_lease_expires_at = (params[6] as string | null) ?? row.quota_lease_expires_at;
      row.provider_poll_attempts += params[7] === true ? 1 : 0;
      row.updated_at = new Date().toISOString();
      return { rows: [row] as unknown as Row[] };
    }
    return { rows: [] as Row[] };
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }

  public lastCall(match: string): { text: string; parameters?: readonly unknown[] } {
    const call = [...this.calls].reverse().find(
      (entry) => entry.text.replace(/\s+/g, ' ').trim().includes(match),
    );
    if (!call) throw new Error(`no SQL call matching ${match}`);
    return call;
  }
}

function assertEnvelope(serialized: string): Record<string, unknown> {
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  expect(parsed.version).toBe(1);
  expect(parsed.algorithm).toBe('aes-256-gcm');
  expect(typeof parsed.ciphertext).toBe('string');
  expect(typeof parsed.aad).toBe('string');
  expect(typeof parsed.plaintextSha256).toBe('string');
  expect(parsed.dek).toBeDefined();
  return parsed;
}

describe('SEC-ENC-02 ledger — seal before SQL', () => {
  test('claim persists the request as an envelope; no plaintext sentinel reaches the INSERT parameters', async () => {
    const db = new FakeInvocationDb();
    const ledger = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture() });
    const request = makeRequest('inv-seal-1');
    const inputHash = hashInvocationInput(request);

    const claimed = await ledger.claim(request, inputHash);
    expect(claimed.kind).toBe('claimed');
    expect(claimed.record.request).toEqual(request);

    const insert = db.lastCall('INSERT INTO connector_invocations');
    const rawRequest = String(insert.parameters![6]);
    expect(rawRequest).not.toContain('SENTINEL-CRYPTO');
    assertEnvelope(rawRequest);
    expect(db.rows.get(request.invocationId)!.request).not.toEqual(request);
  });

  test('complete persists the provider result as an envelope; content/data/session never appear in SQL parameters', async () => {
    const db = new FakeInvocationDb();
    const ledger = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture() });
    const request = makeRequest('inv-seal-2');
    await ledger.claim(request, hashInvocationInput(request));

    const result: NormalizedProviderResult = {
      content: 'SENTINEL-CRYPTO-RESULT',
      data: { nested: 'SENTINEL-CRYPTO-DATA' },
      sessionRef: 'SENTINEL-CRYPTO-SESSION',
      usage: { inputTokens: 3, outputTokens: 5, measurement: 'measured' },
    };
    const completed = await ledger.complete(request.invocationId, result);
    expect(completed.result?.content).toBe('SENTINEL-CRYPTO-RESULT');
    expect(completed.result?.sessionRef).toBe('SENTINEL-CRYPTO-SESSION');

    const update = db.lastCall("UPDATE connector_invocations SET state = 'SUCCEEDED'");
    const rawResult = String(update.parameters![1]);
    expect(rawResult).not.toContain('SENTINEL-CRYPTO-RESULT');
    expect(rawResult).not.toContain('SENTINEL-CRYPTO-DATA');
    expect(rawResult).not.toContain('SENTINEL-CRYPTO-SESSION');
    assertEnvelope(rawResult);
    expect(JSON.stringify(db.rows.get(request.invocationId)!.result)).not.toContain('SENTINEL-CRYPTO-RESULT');
  });

  test('markPending seals the CR06-04 async session; a later poll without a new session keeps it', async () => {
    const db = new FakeInvocationDb();
    const ledger = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture() });
    const request = makeRequest('inv-seal-3');
    const inputHash = hashInvocationInput(request);
    await ledger.claim(request, inputHash);

    const dueAt = new Date(Date.now() + 30_000).toISOString();
    const pending = await ledger.markPending(request.invocationId, dueAt, 'pr-1', undefined, undefined, true, 'SENTINEL-CRYPTO-SESS');
    expect(pending.sessionRef).toBe('SENTINEL-CRYPTO-SESS');

    const mark = db.lastCall("UPDATE connector_invocations SET state = 'PENDING'");
    const rawSession = String(mark.parameters![8]);
    expect(rawSession).not.toContain('SENTINEL-CRYPTO-SESS');
    assertEnvelope(rawSession);
    expect((await ledger.get(request.invocationId))?.sessionRef).toBe('SENTINEL-CRYPTO-SESS');

    // Resume: due poll claims POLLING, then markPending without a session must
    // not erase the stored one.
    const dueMs = Date.parse(dueAt) + 1;
    const leaseToken = await ledger.claimPendingPoll(request.invocationId, inputHash, dueMs, 30_000);
    expect(typeof leaseToken).toBe('string');
    await ledger.markPending(request.invocationId, new Date(dueMs + 500).toISOString(), undefined, leaseToken);
    expect((await ledger.get(request.invocationId))?.sessionRef).toBe('SENTINEL-CRYPTO-SESS');
  });

  test('replay, restart and conflict reads open the stored envelopes to the original values', async () => {
    const db = new FakeInvocationDb();
    const request = makeRequest('inv-seal-4');
    const inputHash = hashInvocationInput(request);
    const first = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture() });
    await first.claim(request, inputHash);
    await first.markPending(request.invocationId, new Date(Date.now() + 60_000).toISOString(), 'pr-4', undefined, undefined, true, 'sess-4');
    await first.cancel(request.invocationId);

    // A fresh process reads the same durable store.
    const restarted = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture() });
    const read = await restarted.get(request.invocationId);
    expect(read?.request).toEqual(request);
    expect(read?.sessionRef).toBe('sess-4');
    expect(read?.state).toBe('CANCELLED');

    const replay = await restarted.claim(request, inputHash);
    expect(replay.kind).toBe('replay');
    expect(replay.record.request).toEqual(request);
    expect(replay.record.sessionRef).toBe('sess-4');

    const drifted = await restarted.claim({ ...request, input: { prompt: 'changed' } }, 'different-hash');
    expect(drifted.kind).toBe('conflict');
    expect(drifted.record.request).toEqual(request);
  });

  test('key rotation: envelopes written under v1 stay readable and new writes use v2', async () => {
    const db = new FakeInvocationDb();
    const v1 = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture({ '1': KEY_1 }, 1) });
    const request = makeRequest('inv-rotate');
    const inputHash = hashInvocationInput(request);
    await v1.claim(request, inputHash);
    await v1.complete(request.invocationId, { content: 'turn one', sessionRef: 'sess-one' });

    const rotated = new PostgresInvocationLedger(db, {
      fieldCrypto: cryptoFixture({ '1': KEY_1, '2': KEY_2 }, 2),
    });
    const opened = await rotated.get(request.invocationId);
    expect(opened?.request).toEqual(request);
    expect(opened?.result?.content).toBe('turn one');

    const next = makeRequest('inv-rotate-2', 'SENTINEL-ROTATE');
    await rotated.claim(next, hashInvocationInput(next));
    await rotated.markPending(next.invocationId, new Date(Date.now() + 60_000).toISOString(), 'pr-r', undefined, undefined, true, 'sess-two');
    const write = db.lastCall("UPDATE connector_invocations SET state = 'PENDING'");
    const envelope = assertEnvelope(String(write.parameters![8]));
    expect((envelope.dek as Record<string, unknown>).keyVersion).toBe(2);
    expect((await rotated.get(next.invocationId))?.sessionRef).toBe('sess-two');
  });
});

describe('SEC-ENC-02 ledger — fail-closed negatives', () => {
  test('wrong tenant, transplanted row and wrong slot are refused, never decrypted', async () => {
    const db = new FakeInvocationDb();
    const ledger = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture() });
    const request = makeRequest('inv-aad');
    await ledger.claim(request, hashInvocationInput(request));

    // Wrong tenant on the row.
    db.rows.get(request.invocationId)!.tenant_id = 'tenant-b';
    await expect(ledger.get(request.invocationId)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    db.rows.get(request.invocationId)!.tenant_id = 'tenant-a';

    // Row transplant: same envelope under another invocation id.
    const row = db.rows.get(request.invocationId)!;
    db.rows.set('inv-aad-other', { ...row, invocation_id: 'inv-aad-other' });
    await expect(ledger.get('inv-aad-other')).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });

    // Slot transplant: the request envelope moved into the result column.
    db.rows.get(request.invocationId)!.result = row.request;
    await expect(ledger.get(request.invocationId)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
  });

  test('tampered ciphertext is refused as an authenticated failure, not returned', async () => {
    const db = new FakeInvocationDb();
    const ledger = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture() });
    const request = makeRequest('inv-tamper');
    await ledger.claim(request, hashInvocationInput(request));

    const stored = db.rows.get(request.invocationId)!;
    const envelope = stored.request as Record<string, unknown>;
    const bytes = Buffer.from(String(envelope.ciphertext), 'base64');
    bytes[0] = bytes[0]! ^ 0x01;
    stored.request = { ...envelope, ciphertext: bytes.toString('base64') };

    await expect(ledger.get(request.invocationId)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
  });

  test('a wrapping outage creates no row and no plaintext fallback', async () => {
    const db = new FakeInvocationDb();
    const downProvider: InvocationDekKeyProvider = {
      wrapDek: async () => { throw new Error('transit down'); },
      unwrapDek: async () => { throw new Error('transit down'); },
    };
    const ledger = new PostgresInvocationLedger(db, {
      fieldCrypto: createInvocationFieldCrypto(downProvider, KEY_REF),
    });
    const request = makeRequest('inv-outage', 'SENTINEL-OUTAGE');

    await expect(ledger.claim(request, hashInvocationInput(request))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      safeToRetry: true,
    });
    expect(db.insertCount).toBe(0);
    expect(db.rows.size).toBe(0);
    expect(JSON.stringify(db.calls)).not.toContain('SENTINEL-OUTAGE');
  });

  test('an unconfigured deployment refuses to persist sensitive fields', async () => {
    const db = new FakeInvocationDb();
    const ledger = new PostgresInvocationLedger(db);
    const request = makeRequest('inv-unconfigured', 'SENTINEL-NO-KEY');

    await expect(ledger.claim(request, hashInvocationInput(request))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      safeToRetry: false,
    });
    expect(db.insertCount).toBe(0);
    expect(JSON.stringify(db.calls)).not.toContain('SENTINEL-NO-KEY');
  });

  test('strict reads refuse a legacy plaintext row instead of serving it', async () => {
    const db = new FakeInvocationDb();
    seedLegacyPlaintextRow(db, 'inv-legacy');
    const ledger = new PostgresInvocationLedger(db, { fieldCrypto: cryptoFixture() });
    await expect(ledger.get('inv-legacy')).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
  });

  test('the explicit migration window reads legacy rows but still refuses plaintext writes', async () => {
    const db = new FakeInvocationDb();
    const request = seedLegacyPlaintextRow(db, 'inv-legacy-window');
    const ledger = new PostgresInvocationLedger(db, {
      fieldCrypto: cryptoFixture(),
      legacyPlaintextReads: true,
    });

    const read = await ledger.get(request.invocationId);
    expect(read?.request).toEqual(request);
    expect(read?.sessionRef).toBe('sess-legacy');

    const replay = await ledger.claim(request, hashInvocationInput(request));
    expect(replay.kind).toBe('replay');

    // The window is read-only: a NEW invocation still needs sealing, and a
    // missing crypto seam is refused even inside the window.
    const noCrypto = new PostgresInvocationLedger(db, { legacyPlaintextReads: true });
    const blocked = makeRequest('inv-window-blocked', 'SENTINEL-WINDOW');
    await expect(noCrypto.claim(blocked, hashInvocationInput(blocked))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      safeToRetry: false,
    });

    const fresh = makeRequest('inv-window-new', 'SENTINEL-WINDOW');
    await ledger.claim(fresh, hashInvocationInput(fresh));
    await ledger.markPending(
      fresh.invocationId,
      new Date(Date.now() + 60_000).toISOString(),
      undefined,
      undefined,
      undefined,
      false,
      'sess-new',
    );
    const sealed = db.lastCall("UPDATE connector_invocations SET state = 'PENDING'");
    assertEnvelope(String(sealed.parameters![8]));
  });
});

function seedLegacyPlaintextRow(db: FakeInvocationDb, invocationId: string): LocalInvocationRequest {
  const request = makeRequest(invocationId, 'LEGACY');
  db.rows.set(invocationId, {
    invocation_id: invocationId,
    tenant_id: 'tenant-a',
    operation_id: request.operationId,
    task_id: request.taskId,
    step_key: request.stepKey,
    input_hash: hashInvocationInput(request),
    request,
    state: 'PENDING',
    result: { content: 'legacy result' },
    error_code: null,
    provider_request_id: null,
    session_ref: 'sess-legacy',
    next_poll_at: new Date(Date.now() + 60_000).toISOString(),
    poll_lease_token: null,
    poll_lease_expires_at: null,
    quota_lease_key: null,
    quota_lease_id: null,
    quota_lease_expires_at: null,
    provider_poll_attempts: 1,
    updated_at: new Date().toISOString(),
  });
  return request;
}

describe('SEC-ENC-02 crypto error taxonomy', () => {
  test('InvocationFieldCryptoError is never mistaken for a ConnectorError', () => {
    const error = new InvocationFieldCryptoError('KEY_PROVIDER_FAILED', 'x');
    expect(error.name).toBe('InvocationFieldCryptoError');
    expect(error.code).toBe('KEY_PROVIDER_FAILED');
  });
});
