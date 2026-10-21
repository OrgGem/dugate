/**
 * PC-07 — retry and operation ownership (OFFLINE).
 *
 * Proves the three rules the packet exists for:
 *
 *  A. **Reauthorization is CURRENT authority, and it runs twice** — before the
 *     coalesced-replay check and again immediately before the durable insert.
 *     A revoked key, a revoked root grant or a disabled group function denies.
 *  B. **Every encrypted carrier is re-sealed for the NEW AAD.** Ciphertext is
 *     never copied between rows, so an envelope sealed for operation A cannot
 *     be opened as operation B.
 *  C. **The pinned execution is preserved** — owner key, config snapshot,
 *     connector pins, callback policy, prompt pins and workflow schema all ride
 *     along; only identity, state and the sealed carriers change.
 */
import type { PoolClient } from 'pg';
import type { MetadataCrypto } from '../src/modules/runtime/metadata-crypto';
import type { MetadataReader } from '../src/modules/encryption/metadata-read-policy';
import {
  RETRY_AUTHORIZATION_CODES,
  retryOperation,
} from '../src/modules/operations/retry';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';
const CHILD_PROFILE = '66666666-6666-4666-8666-666666666666';

/* ------------------------------------------------------------------ */
/* AAD-isolating crypto fake                                           */
/* ------------------------------------------------------------------ */

interface AadContext {
  tenantId: string;
  slot: string;
  refId: string;
}

function aadOf(context: AadContext): string {
  return `${context.tenantId}|${context.slot}|${context.refId}`;
}

interface SealedToken {
  __sealed: string;
}

/**
 * Behaves like the real envelope: sealing records the AAD it was bound to, and
 * opening a token under any other AAD fails closed with CONTEXT_MISMATCH. That
 * is the property a copied ciphertext would violate.
 */
class AadCrypto {
  readonly tokens = new Map<string, { aad: string; value: unknown }>();
  readonly seals: Array<{ slot: string; refId: string }> = [];
  readonly opens: Array<{ slot: string; refId: string }> = [];
  private sequence = 0;

  async seal(value: unknown, context: AadContext): Promise<SealedToken> {
    const id = `sealed_${++this.sequence}`;
    this.tokens.set(id, { aad: aadOf(context), value });
    this.seals.push({ slot: context.slot, refId: context.refId });
    return { __sealed: id };
  }

  isSealed(value: unknown): value is SealedToken {
    return typeof value === 'object' && value !== null && '__sealed' in (value as Record<string, unknown>);
  }

  async readStored(value: unknown, context: AadContext): Promise<unknown> {
    if (!this.isSealed(value)) throw new Error('NOT_SEALED');
    const entry = this.tokens.get(value.__sealed);
    if (!entry) throw new Error('UNKNOWN_ENVELOPE');
    this.opens.push({ slot: context.slot, refId: context.refId });
    if (entry.aad !== aadOf(context)) {
      throw new Error(`CONTEXT_MISMATCH: sealed for ${entry.aad}, opened as ${aadOf(context)}`);
    }
    return entry.value;
  }

  async readStoredText(value: unknown, context: AadContext): Promise<string | undefined> {
    return String(await this.readStored(value, context));
  }

  get mode(): 'strict' {
    return 'strict';
  }

  allowPlaintext(): boolean {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Scripted world                                                      */
/* ------------------------------------------------------------------ */

interface OperationRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  state: string;
  root_task_id: string;
  api_key_id?: string;
  profile_id?: string;
  profile_revision?: number;
  deadline_at?: string | null;
  created_at?: string | null;
}

interface WorldOptions {
  operation?: Partial<OperationRow>;
  key?: { id?: string; status?: string; key_mode?: string | null } | null;
  grant?: { groupId?: string; accessVersion?: number } | null;
  /** PC-R03: the grant row's state as the LOCKED read sees it. */
  grantState?: 'ACTIVE' | 'REVOKED';
  groupFunction?: { enabled?: boolean; present?: boolean; functionId?: string } | null;
  legacyMembership?: boolean;
  existingRetry?: boolean;
  unknownOutcome?: boolean;
  submissionsPaused?: boolean;
}

interface Statement {
  sql: string;
  params: unknown[];
}

const BASE_OPERATION: OperationRow = {
  id: OPERATION,
  tenant_id: TENANT,
  state: 'FAILED',
  root_task_id: TASK,
  api_key_id: KEY,
  business_id: 'document-core',
  business_version: '1.0.0',
  action: 'ingest',
  endpoint_slug: 'ingest:parse',
  profile_id: CHILD_PROFILE,
  profile_revision: 3,
  input_ref: null as unknown as undefined,
  submit_artifacts: [],
  connector_bindings: [{ slot: 'extract', connectorId: 'connector-1', revision: 7 }],
  profile_policy_snapshot: { tenantId: TENANT, profileId: CHILD_PROFILE, profileRevision: 3 },
  prompt_revisions_pin: { extract: 'digest-1' },
  callback_policy: { mode: 'notification_with_result' },
  callback_url: 'https://callback.example.com/hook',
  pipeline_json: [{ processor: 'ingest' }],
  output_format: 'markdown',
  tenant_defaults_digest: 'settings-digest-1',
  tenant_defaults_ai_revision: 4,
  tenant_defaults_prompt_revision: 5,
  tenant_default_connector_id: 'connector-default',
  tenant_default_connector_revision: 2,
  workflow_schema_slug: 'invoice-flow',
  workflow_schema_revision: 9,
  workflow_schema_digest: 'sha256:workflow',
  deadline_at: '2026-10-01T00:00:00.000Z',
  created_at: '2026-09-30T00:00:00.000Z',
};

function world(options: WorldOptions = {}) {
  const crypto = new AadCrypto();
  const statements: Statement[] = [];

  // The four operation-bound carriers are sealed envelopes under THIS row.
  const carriers: Record<string, SealedToken> = {
    input_ref: { __sealed: 'old_input' },
    prompt_overrides_ref: { __sealed: 'old_prompts' },
    tenant_defaults_ref: { __sealed: 'old_defaults' },
    connector_recipe_pins_ref: { __sealed: 'old_recipe_pins' },
  };
  crypto.tokens.set('old_input', { aad: aadOf({ tenantId: TENANT, slot: 'operations.input_ref', refId: OPERATION }), value: { q: 'pinned' } });
  crypto.tokens.set('old_prompts', { aad: aadOf({ tenantId: TENANT, slot: 'operations.prompt_overrides_ref', refId: OPERATION }), value: { carrier: 'pinned' } });
  crypto.tokens.set('old_defaults', { aad: aadOf({ tenantId: TENANT, slot: 'operations.tenant_defaults_ref', refId: OPERATION }), value: { aiRevision: 4 } });
  crypto.tokens.set('old_recipe_pins', {
    aad: aadOf({ tenantId: TENANT, slot: 'operations.connector_recipe_pins_ref', refId: OPERATION }),
    value: { connectorRecipePins: { extract: { revision: 7 } } },
  });
  // Explicit overrides win, so a case can null a carrier out.
  const operation: OperationRow = { ...BASE_OPERATION, ...carriers, ...options.operation };

  const taskPayload: SealedToken = { __sealed: 'old_payload' };
  crypto.tokens.set('old_payload', { aad: aadOf({ tenantId: TENANT, slot: 'tasks.payload_ref', refId: TASK }), value: { input: { q: 'pinned' } } });

  const keyRow = options.key === undefined ? { id: KEY, status: 'ACTIVE', key_mode: 'GROUP_MANAGED' } : options.key;
  const grant = options.grant === undefined ? { groupId: GROUP, accessVersion: 11 } : options.grant;
  const groupFunction = options.groupFunction === undefined
    ? { enabled: true, present: true, functionId: 'ingest:parse' }
    : options.groupFunction;

  const query = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    statements.push({ sql: normalized, params });

    if (normalized.startsWith('SELECT * FROM operations WHERE id=$1 FOR UPDATE')) {
      return { rows: [{ ...operation }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT * FROM operations WHERE id=$1')) {
      return { rows: [{ ...operation }], rowCount: 1 };
    }
    // PC-R03 locks, in the order the retry acquires them. Each row-level lock
    // mirrors the same authority fact the plain read returns, so a fixture that
    // models "revoked" denies at the lock as well as at the read.
    if (normalized.startsWith('SELECT group_id FROM profile_groups')) {
      return grant === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ group_id: grant.groupId }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT status, key_mode FROM api_keys')) {
      return keyRow === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ status: keyRow.status, key_mode: keyRow.key_mode }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT state FROM profile_group_api_keys')) {
      if (grant === null) return { rows: [], rowCount: 0 };
      return { rows: [{ state: options.grantState ?? 'ACTIVE' }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT id, tenant_id, status, key_mode FROM api_keys')) {
      return keyRow === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ tenant_id: TENANT, ...keyRow }], rowCount: 1 };
    }
    if (normalized.includes('FROM profile_group_api_keys g JOIN profile_groups p')) {
      return grant === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ group_id: grant.groupId, tenant_id: TENANT, access_version: grant.accessVersion, granted_at: '2026-10-01T00:00:00.000Z' }], rowCount: 1 };
    }
    if (normalized.includes('FROM profile_groups g JOIN profile_group_members m')) {
      if (groupFunction === null || !groupFunction.present) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          group_revision: 4,
          profile_id: CHILD_PROFILE,
          function_id: groupFunction.functionId,
          enabled: groupFunction.enabled,
        }],
        rowCount: 1,
      };
    }
    if (normalized.startsWith('SELECT 1 FROM profile_api_keys')) {
      return options.legacyMembership === false ? { rows: [], rowCount: 0 } : { rows: [{}], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT k.name,k.spending_limit')) {
      return { rows: [{ name: 'key', spending_limit: '0', total_used: '0', tenant_id: TENANT }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT ue.event_id')) return { rows: [], rowCount: 0 };
    if (normalized.includes('WHERE retry_of=')) {
      return options.existingRetry
        ? { rows: [{ id: 'op-existing-retry', state: 'RUNNING' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('SELECT id, state, error_code FROM tasks WHERE operation_id=$1')) {
      return options.unknownOutcome
        ? { rows: [{ id: 'task-child', state: 'FAILED', error_code: 'INVOCATION_UNKNOWN' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('SELECT * FROM tasks WHERE id=$1 FOR UPDATE')) {
      return { rows: [{ id: TASK, payload_ref: taskPayload, kind: 'root', max_attempts: 4 }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT * FROM tasks WHERE id=$1')) {
      return { rows: [{ id: TASK, payload_ref: taskPayload, kind: 'root', max_attempts: 4 }], rowCount: 1 };
    }
    if (normalized.includes('SELECT enabled,activation_revision,submissions_paused,pre_drain_version')) {
      return {
        rows: [{
          enabled: true,
          activation_revision: 3,
          submissions_paused: options.submissionsPaused === true,
          pre_drain_version: options.submissionsPaused === true ? '1.0.0' : null,
        }],
        rowCount: 1,
      };
    }
    if (normalized.includes('SELECT version,status,is_active FROM business_versions')) {
      return { rows: [{ version: '1.0.0', status: 'ENABLED', is_active: true }], rowCount: 1 };
    }
    if (normalized.includes('SELECT payload FROM outbox')) {
      return { rows: [{ payload: { priority: 5 } }], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO operations')) return { rows: [], rowCount: 1 };
    if (normalized.startsWith('INSERT INTO tasks') || normalized.startsWith('INSERT INTO outbox')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected retry SQL: ${normalized}`);
  };

  return {
    crypto,
    statements,
    operation,
    carriers,
    client: { query } as unknown as PoolClient,
    metadataCrypto: crypto as unknown as MetadataCrypto,
    reader: crypto as unknown as MetadataReader,
    insertParams(): unknown[] {
      const insert = statements.find((entry) => entry.sql.startsWith('INSERT INTO operations'));
      return insert ? insert.params : [];
    },
    quiet(): void {
      // no-op hook kept for symmetry with the other suites
    },
  };
}

async function expectDenied(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status: 409, code });
}

function groupOperation(): WorldOptions {
  return {};
}

/* ------------------------------------------------------------------ */
/* A. reauthorization                                                  */
/* ------------------------------------------------------------------ */

describe('PC-07 / successful retry under an active key and an active group grant', () => {
  it('creates a fresh execution that preserves the pinned owner and snapshot', async () => {
    const w = world(groupOperation());
    const result = await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);

    expect(result).toMatchObject({ retryOf: OPERATION, replayed: false, state: 'ACCEPTED' });
    expect(result.operationId).not.toBe(OPERATION);

    const insert = w.statements.find((entry) => entry.sql.startsWith('INSERT INTO operations'));
    expect(insert).toBeDefined();
    // Ownership + pins travel with the copy: they are read by column name from
    // the original row, so a same-named column is the only way to preserve them.
    for (const column of [
      'api_key_id', 'profile_id', 'profile_revision', 'connector_bindings',
      'profile_policy_snapshot', 'callback_policy', 'prompt_revisions_pin',
      'workflow_schema_slug', 'workflow_schema_revision', 'workflow_schema_digest',
      'tenant_defaults_digest', 'tenant_defaults_ai_revision', 'tenant_defaults_prompt_revision',
      'tenant_default_connector_id', 'tenant_default_connector_revision',
    ]) {
      expect(insert!.sql).toContain(column);
    }
    expect(insert!.params[0]).toBe(OPERATION);
  });

  it('reads authority before the coalesced-replay check', async () => {
    const w = world(groupOperation());
    await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);

    const indexOf = (predicate: (sql: string) => boolean) =>
      w.statements.findIndex((entry) => predicate(entry.sql));
    const keyRead = indexOf((sql) => sql.startsWith('SELECT id, tenant_id, status, key_mode FROM api_keys'));
    const grantRead = indexOf((sql) => sql.includes('FROM profile_group_api_keys g JOIN profile_groups p'));
    const coalesce = indexOf((sql) => sql.includes('WHERE retry_of='));
    expect(keyRead).toBeGreaterThanOrEqual(0);
    expect(grantRead).toBeGreaterThan(keyRead);
    expect(coalesce).toBeGreaterThan(grantRead);
  });

  it('reauthorizes a second time immediately before the insert', async () => {
    const w = world(groupOperation());
    await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);

    const keyReads = w.statements.filter((entry) => entry.sql.startsWith('SELECT id, tenant_id, status, key_mode FROM api_keys'));
    // PC-R03 adds one more current-authority read: the preflight, the
    // authoritative pass that gates the coalesced replay, and the final pass
    // immediately before the durable write.
    expect(keyReads).toHaveLength(3);
    const lockIndex = w.statements.findIndex((entry) => entry.sql.startsWith('SELECT * FROM operations WHERE id=$1 FOR UPDATE'));
    const insertIndex = w.statements.findIndex((entry) => entry.sql.startsWith('INSERT INTO operations'));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(lockIndex);
    // Second read sits between the operation lock and the durable write.
    let secondKeyRead = -1;
    let lastKeyRead = -1;
    w.statements.forEach((entry, index) => {
      if (!entry.sql.startsWith('SELECT id, tenant_id, status, key_mode FROM api_keys')) return;
      if (secondKeyRead === -1) secondKeyRead = index;
      lastKeyRead = index;
    });
    expect(secondKeyRead).toBeLessThan(lockIndex);
    expect(lastKeyRead).toBeGreaterThan(lockIndex);
    expect(lastKeyRead).toBeLessThan(insertIndex);
  });
});

describe('PC-07 / reauthorization denies current-authority failures', () => {
  it('denies a globally revoked key with API_KEY_REVOKED before any execution', async () => {
    const w = world({ key: { id: KEY, status: 'REVOKED', key_mode: 'GROUP_MANAGED' } });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.API_KEY_REVOKED,
    );
    expect(w.statements.some((entry) => entry.sql.startsWith('INSERT INTO operations'))).toBe(false);
    expect(w.statements.some((entry) => entry.sql.includes('WHERE retry_of='))).toBe(false);
  });

  it('denies a missing key with KEY_INACTIVE', async () => {
    const w = world({ key: null });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.KEY_INACTIVE,
    );
    expect(w.statements.some((entry) => entry.sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('denies an operation with no recorded owner key', async () => {
    const w = world({ operation: { api_key_id: undefined } });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.KEY_INACTIVE,
    );
  });

  it('denies a revoked root grant with GRANT_REVOKED', async () => {
    const w = world({ grant: null });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.GRANT_REVOKED,
    );
    expect(w.statements.some((entry) => entry.sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('denies a function disabled in the current group config with ENDPOINT_DISABLED', async () => {
    const w = world({ groupFunction: { enabled: false, present: true, functionId: 'ingest:parse' } });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.ENDPOINT_DISABLED,
    );
    expect(w.statements.some((entry) => entry.sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('denies a function removed from the current group config with ENDPOINT_DISABLED', async () => {
    const w = world({ groupFunction: { enabled: true, present: false, functionId: 'ingest:parse' } });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.ENDPOINT_DISABLED,
    );
  });

  it('denies a legacy retry whose profile membership was revoked', async () => {
    const w = world({
      key: { id: KEY, status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' },
      legacyMembership: false,
    });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.GRANT_REVOKED,
    );
    expect(w.statements.some((entry) => entry.sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('treats an unclassified key as standalone, never as group-managed', async () => {
    const w = world({ key: { id: KEY, status: 'ACTIVE', key_mode: null } });
    const result = await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);
    expect(result).toMatchObject({ replayed: false });
    // No root-grant read was attempted for an unclassified key.
    expect(w.statements.some((entry) => entry.sql.includes('FROM profile_group_api_keys g JOIN profile_groups p'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* B. carrier resealing                                                */
/* ------------------------------------------------------------------ */

describe('PC-07 / cryptographic carriers are re-sealed for the new AAD', () => {
  it('opens every carrier under the old AAD and seals it under the new one', async () => {
    const w = world(groupOperation());
    const result = await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);
    const newOperationId = String(result.operationId);

    // Every open names the ORIGINAL operation/task, every seal the NEW one.
    expect(w.crypto.opens.map((entry) => entry.refId).sort())
      .toEqual([OPERATION, OPERATION, OPERATION, OPERATION, TASK].sort());
    const newTaskId = String(w.insertParams()[3]);
    const sealPairs = w.crypto.seals.map((entry) => `${entry.slot}@${entry.refId}`).sort();
    expect(sealPairs).toEqual([
      `operations.connector_recipe_pins_ref@${newOperationId}`,
      `operations.input_ref@${newOperationId}`,
      `operations.prompt_overrides_ref@${newOperationId}`,
      `operations.tenant_defaults_ref@${newOperationId}`,
      `tasks.payload_ref@${newTaskId}`,
    ].sort());
  });

  it('binds each resealed carrier to the new row and never copies ciphertext', async () => {
    const w = world(groupOperation());
    await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);

    const params = w.insertParams();
    // params: [operationId, newId, state, taskId, input, correlationId, prompts,
    //          tenantDefaults, recipePins]
    const inputRef = JSON.parse(String(params[4])) as SealedToken;
    const promptsRef = JSON.parse(String(params[6])) as SealedToken;
    const defaultsRef = JSON.parse(String(params[7])) as SealedToken;
    const recipeRef = JSON.parse(String(params[8])) as SealedToken;

    // Not the original envelopes.
    expect(inputRef.__sealed).not.toBe('old_input');
    expect(promptsRef.__sealed).not.toBe('old_prompts');
    expect(defaultsRef.__sealed).not.toBe('old_defaults');
    expect(recipeRef.__sealed).not.toBe('old_recipe_pins');

    // Each new envelope is bound to the NEW operation id.
    const newOperationId = String(params[1]);
    expect(w.crypto.tokens.get(inputRef.__sealed)!.aad)
      .toBe(`${TENANT}|operations.input_ref|${newOperationId}`);
    expect(w.crypto.tokens.get(defaultsRef.__sealed)!.aad)
      .toBe(`${TENANT}|operations.tenant_defaults_ref|${newOperationId}`);
    expect(w.crypto.tokens.get(recipeRef.__sealed)!.aad)
      .toBe(`${TENANT}|operations.connector_recipe_pins_ref|${newOperationId}`);
  });

  it('proves the AAD isolation: an old envelope cannot open as the new row', async () => {
    const w = world(groupOperation());
    const result = await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);
    const newOperationId = String(result.operationId);

    // The retry row carries a fresh envelope, and the OLD ciphertext still only
    // opens for the OLD identity — which is why copying it would fail closed.
    await expect(w.crypto.readStored(w.carriers.input_ref, {
      tenantId: TENANT,
      slot: 'operations.input_ref',
      refId: newOperationId,
    })).rejects.toThrow(/CONTEXT_MISMATCH/);

    await expect(w.crypto.readStored(w.carriers.input_ref, {
      tenantId: TENANT,
      slot: 'operations.input_ref',
      refId: OPERATION,
    })).resolves.toEqual({ q: 'pinned' });
  });

  it('keeps a null carrier null instead of sealing an absent snapshot', async () => {
    const w = world({
      operation: { tenant_defaults_ref: null, connector_recipe_pins_ref: null },
    });
    await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);
    const params = w.insertParams();
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* C. coalescing + state invariants                                    */
/* ------------------------------------------------------------------ */

describe('PC-07 / coalesced replay', () => {
  it('re-authorizes before answering a replayed sibling', async () => {
    const w = world({ existingRetry: true });
    const result = await retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader);

    expect(result).toMatchObject({ operationId: 'op-existing-retry', replayed: true });
    const keyRead = w.statements.findIndex((entry) => entry.sql.startsWith('SELECT id, tenant_id, status, key_mode FROM api_keys'));
    const coalesce = w.statements.findIndex((entry) => entry.sql.includes('WHERE retry_of='));
    expect(keyRead).toBeGreaterThanOrEqual(0);
    expect(coalesce).toBeGreaterThan(keyRead);
    expect(w.statements.some((entry) => entry.sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('denies a revoked key even when a sibling execution is active', async () => {
    const w = world({ existingRetry: true, key: { id: KEY, status: 'REVOKED', key_mode: 'GROUP_MANAGED' } });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.API_KEY_REVOKED,
    );
    // The coalescing read never ran: a denied caller cannot probe for siblings.
    expect(w.statements.some((entry) => entry.sql.includes('WHERE retry_of='))).toBe(false);
  });

  it('denies a revoked grant even when a sibling execution is active', async () => {
    const w = world({ existingRetry: true, grant: null });
    await expectDenied(
      retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader),
      RETRY_AUTHORIZATION_CODES.GRANT_REVOKED,
    );
    expect(w.statements.some((entry) => entry.sql.includes('WHERE retry_of='))).toBe(false);
  });
});

describe('PC-07 / state invariants are unchanged', () => {
  it('still blocks an unknown provider outcome anywhere in the task tree', async () => {
    const w = world({ unknownOutcome: true });
    await expect(retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader))
      .rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect(w.statements.some((entry) => entry.sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('still refuses a retry while the pinned version drains', async () => {
    const w = world({ submissionsPaused: true });
    await expect(retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader))
      .rejects.toMatchObject({ code: 'BUSINESS_SUBMISSIONS_PAUSED' });
    expect(w.statements.some((entry) => entry.sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('rejects a non-terminal source operation before any authorization read', async () => {
    const w = world({ operation: { state: 'RUNNING' } });
    await expect(retryOperation(w.client, OPERATION, TENANT, w.metadataCrypto, w.reader))
      .rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(w.statements.some((entry) => entry.sql.startsWith('SELECT id, tenant_id, status, key_mode'))).toBe(false);
  });
});
