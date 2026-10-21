/**
 * PC-R05 regression — Connector readiness probes and provider-test
 * authorization must use the CURRENT root grant for `GROUP_MANAGED` keys.
 *
 * Managed keys hold no `profile_api_keys` rows (conversion tombstones them),
 * so the pre-R05 child-membership joins denied every valid managed key. The
 * cases below pin:
 *   - managed allow (grant + active group revision member pin + bound connector),
 *   - managed deny (revoked grant, disabled function, unbound connector,
 *     cross-tenant row),
 *   - legacy modes keep their exact previous scope (membership path),
 *   - unknown mode denies without touching the database,
 *   - the public route authorizes before any outbound probe.
 */
import { authorizeConnectorProbe } from '../src/modules/connectors/probe-authorization';
import {
  assertManagedFunctionAuthority,
  lockProviderTestAuthority,
  reserveProviderTestRun,
  validateLocalActorInTransaction,
} from '../src/modules/connectors/provider-test';
import type { AdminActionAuth } from '../src/modules/admin-actions/rbac';
import { handlePublicRoutes } from '../src/http/routes/public';
import type { RouteContext } from '../src/http/route-context';
import type { Db } from '../src/db/db';
import type { PoolClient } from 'pg';
import { createSubmissionService } from '../src/modules/operations/submission';

const API_KEY_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';

interface QueryCall { sql: string; params: unknown[] }

/** Pattern-driven fake: each answer is chosen by the SQL the production code issues. */
function fakeDb(answers: Array<{ match: RegExp; rows: Record<string, unknown>[] }>) {
  const calls: QueryCall[] = [];
  const handler = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const answer = answers.find((candidate) => candidate.match.test(sql));
    return { rows: answer?.rows ?? [], rowCount: answer?.rows.length ?? 0 };
  };
  const query = jest.fn(handler);
  const db = { query: handler } as unknown as Pick<Db, 'query'> & Pick<PoolClient, 'query'>;
  return { db, query, calls };
}

const managedRow = {
  api_key_id: API_KEY_ID,
  tenant_id: TENANT_ID,
  enabled: true,
  connector_bindings: { reasoning: { connectorId: 'connector-a', revision: 2 } },
};

const managedPrincipal = { id: API_KEY_ID, tenantId: TENANT_ID, keyMode: 'GROUP_MANAGED' as const };

describe('PC-R05 probe authorization — GROUP_MANAGED uses the root grant', () => {
  it('allows a managed key whose active group revision binds the connector', async () => {
    const db = fakeDb([{ match: /profile_group_api_keys/, rows: [managedRow] }]);
    await authorizeConnectorProbe(db.db, managedPrincipal, 'connector-a');
    const sql = db.calls[0]!.sql;
    // The managed path must never fall back to child memberships.
    expect(sql).toContain('profile_group_api_keys');
    expect(sql).toContain('profile_group_members');
    expect(sql).toContain("grp.auth_authority = 'GROUP_GRANT'");
    expect(sql).toContain('gm.group_revision = grp.active_revision');
    expect(sql).not.toContain('profile_api_keys');
    expect(db.calls[0]!.params).toEqual([API_KEY_ID, TENANT_ID]);
  });

  it.each([
    ['a revoked/absent root grant', []],
    ['a disabled function', [{ ...managedRow, enabled: false }]],
    ['a different connector', [{ ...managedRow, connector_bindings: { reasoning: { connectorId: 'connector-b', revision: 1 } } }]],
    ['a row from another tenant', [{ ...managedRow, tenant_id: 'tenant-b' }]],
    ['a row for another key', [{ ...managedRow, api_key_id: 'key-b' }]],
    ['an empty binding map', [{ ...managedRow, connector_bindings: {} }]],
  ])('denies %s', async (_name, rows) => {
    await expect(authorizeConnectorProbe(fakeDb([{ match: /profile_group_api_keys/, rows }]).db, managedPrincipal, 'connector-a'))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('fails closed on malformed stored bindings without echoing them', async () => {
    await expect(authorizeConnectorProbe(
      fakeDb([{ match: /profile_group_api_keys/, rows: [{ ...managedRow, connector_bindings: { secret: 'sensitive' } }] }]).db,
      managedPrincipal,
      'connector-a',
    )).rejects.toMatchObject({ status: 503, message: 'connector probe authorization is unavailable' });
  });
});

describe('PC-R05 probe authorization — legacy modes keep their previous scope', () => {
  it('LEGACY_STANDALONE still authorizes through active child membership', async () => {
    const db = fakeDb([{ match: /profile_active_revisions/, rows: [managedRow] }]);
    await authorizeConnectorProbe(db.db, { ...managedPrincipal, keyMode: 'LEGACY_STANDALONE' }, 'connector-a');
    expect(db.calls[0]!.sql).toContain('profile_api_keys');
    expect(db.calls[0]!.sql).not.toContain('profile_group_api_keys');
  });

  it('UNMANAGED_LEGACY keeps the legacy path (no tenant-wide widening)', async () => {
    const db = fakeDb([{ match: /profile_active_revisions/, rows: [] }]);
    await expect(authorizeConnectorProbe(db.db, { ...managedPrincipal, keyMode: 'UNMANAGED_LEGACY' }, 'connector-a'))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(db.calls[0]!.sql).toContain('profile_api_keys');
    expect(db.calls[0]!.sql).not.toContain('profile_group_api_keys');
  });

  it('an unknown/NULL mode denies without any authorization query', async () => {
    const db = fakeDb([]);
    await expect(authorizeConnectorProbe(db.db, { ...managedPrincipal, keyMode: 'MANAGED' as never }, 'connector-a'))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('PC-R05 provider-test managed authority seam', () => {
  const target = {
    tenantId: TENANT_ID,
    apiKeyId: API_KEY_ID,
    profileId: PROFILE_ID,
    profileRevision: 2,
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
  };

  it('authorizes a managed key through the active group revision member pin', async () => {
    const db = fakeDb([{ match: /profile_group_members/, rows: [{ '?column?': 1 }] }]);
    await expect(assertManagedFunctionAuthority(db.db, target)).resolves.toBeUndefined();
    const sql = db.calls[0]!.sql;
    expect(sql).toContain('profile_group_api_keys');
    expect(sql).toContain("g.state = 'ACTIVE'");
    expect(sql).toContain("grp.auth_authority = 'GROUP_GRANT'");
    expect(sql).toContain('gm.group_revision = grp.active_revision');
    expect(sql).toContain('gm.binding_revision = $4');
    expect(sql).not.toContain('profile_api_keys');
    expect(db.calls[0]!.params).toEqual([
      API_KEY_ID, TENANT_ID, PROFILE_ID, 2, 'document-core', '1.0.0', 'extract',
    ]);
  });

  it.each([
    ['a revoked root grant (no matching member row)', []],
  ])('denies %s with 403 before any reservation', async (_name, rows) => {
    await expect(assertManagedFunctionAuthority(fakeDb([{ match: /profile_group_members/, rows }]).db, target))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });
});

describe('PC-R05 public readiness route — managed key end to end', () => {
  function context(probeRows: Record<string, unknown>[]) {
    const db = fakeDb([
      // resolveApiKey (PC-04): the key row carries its explicit mode.
      { match: /key_mode FROM api_keys WHERE hash=/, rows: [{ id: API_KEY_ID, tenant_id: TENANT_ID, key_mode: 'GROUP_MANAGED' }] },
      { match: /profile_group_api_keys/, rows: probeRows },
    ]);
    const testConnector = jest.fn().mockResolvedValue({ connectorId: 'connector-a', ok: true, latencyMs: 1 });
    const ctx = {
      method: 'GET',
      pathname: '/api/v1/connectors/connector-a/test',
      headers: { 'x-api-key': 'fixture-key' },
      db: db.db,
      connectors: { testConnector },
    } as unknown as RouteContext;
    return { ctx, db, testConnector };
  }

  it('serves readiness for a granted managed key without child memberships', async () => {
    const { ctx, testConnector } = context([managedRow]);
    await expect(handlePublicRoutes(ctx)).resolves.toEqual({
      status: 200,
      body: { connectorId: 'connector-a', ok: true, latencyMs: 1 },
    });
    expect(testConnector).toHaveBeenCalledTimes(1);
  });

  it('denies a revoked grant before any outbound probe', async () => {
    const { ctx, testConnector } = context([]);
    await expect(handlePublicRoutes(ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(testConnector).not.toHaveBeenCalled();
  });

  it('denies a disabled managed function before any outbound probe', async () => {
    const { ctx, testConnector } = context([{ ...managedRow, enabled: false }]);
    await expect(handlePublicRoutes(ctx)).rejects.toMatchObject({ status: 403 });
    expect(testConnector).not.toHaveBeenCalled();
  });
});

describe('PC-R05 local USER fence — managed key needs the group pin, not a membership', () => {
  const localAuth = {
    kind: 'cookie',
    role: 'operator',
    csrfOk: true,
    issuer: 'du-local',
    tenantId: TENANT_ID,
    principalId: '55555555-5555-4555-8555-555555555555',
    roleVersion: 3,
  } as unknown as AdminActionAuth;
  const target = {
    tenantId: TENANT_ID,
    apiKeyId: API_KEY_ID,
    profileId: PROFILE_ID,
    profileRevision: 2,
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
  };
  const userRow = { match: /FROM admin_local_users/, rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
  const keyGrant = { match: /admin_local_user_api_key_grants/, rows: [{ '?column?': 1 }] };
  const profileGrant = { match: /admin_local_user_profile_grants/, rows: [{ '?column?': 1 }] };

  it('passes for a managed key with the active group member pin (no profile_api_keys row)', async () => {
    const db = fakeDb([
      userRow,
      { match: /key_mode FROM api_keys/, rows: [{ id: API_KEY_ID, key_mode: 'GROUP_MANAGED' }] },
      keyGrant,
      profileGrant,
      { match: /profile_group_members/, rows: [{ '?column?': 1 }] },
    ]);
    await expect(validateLocalActorInTransaction(db.db as never, localAuth, target)).resolves.toBeUndefined();
    expect(db.calls.some((call) => call.sql.includes('profile_group_members'))).toBe(true);
    // The managed branch must not re-introduce the child-membership join.
    expect(db.calls.some((call) => call.sql.includes('profile_api_keys'))).toBe(false);
  });

  it('denies a managed key the active group revision does not pin', async () => {
    const db = fakeDb([
      userRow,
      { match: /key_mode FROM api_keys/, rows: [{ id: API_KEY_ID, key_mode: 'GROUP_MANAGED' }] },
      keyGrant,
      profileGrant,
      { match: /profile_group_members/, rows: [] },
    ]);
    await expect(validateLocalActorInTransaction(db.db as never, localAuth, target))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('denies a standalone key without the active child membership (legacy fence intact)', async () => {
    const db = fakeDb([
      userRow,
      { match: /key_mode FROM api_keys/, rows: [{ id: API_KEY_ID, key_mode: 'LEGACY_STANDALONE' }] },
      keyGrant,
      profileGrant,
      { match: /profile_api_keys/, rows: [] },
    ]);
    await expect(validateLocalActorInTransaction(db.db as never, localAuth, target))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(db.calls.some((call) => call.sql.includes('profile_api_keys'))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes('profile_group_members'))).toBe(false);
  });

  it('denies an undeclared authority mode before any function check', async () => {
    const db = fakeDb([
      userRow,
      { match: /key_mode FROM api_keys/, rows: [{ id: API_KEY_ID, key_mode: null }] },
      keyGrant,
      profileGrant,
    ]);
    await expect(validateLocalActorInTransaction(db.db as never, localAuth, target))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(db.calls.some((call) => call.sql.includes('profile_api_keys'))).toBe(false);
    expect(db.calls.some((call) => call.sql.includes('profile_group_members'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Codex Finding 2: universal lock order + strict deny ordering        */
/* ------------------------------------------------------------------ */

const GROUP_ID = '44444444-4444-4444-8444-444444444444';

/** A platform bearer: `validateLocalActorInTransaction` returns early, so the
 *  only authority work in the reservation is the seam under test. */
const bearerAuth = { kind: 'bearer', principal: { role: 'platform' } } as unknown as AdminActionAuth;

const ORDER = {
  preflight: /SELECT k\.key_mode/,
  root: /FROM profile_groups grp\s+JOIN profile_group_api_keys g/,
  key: /SELECT id, key_mode FROM api_keys WHERE id=\$1 AND tenant_id=\$2 AND status='ACTIVE'/,
  grant: /FOR SHARE OF g, grp, gm/,
  membership: /FROM profile_api_keys WHERE tenant_id=\$1 AND profile_id=\$2 AND api_key_id=\$3 AND state='ACTIVE'/,
  rate: /count\(\*\) FILTER/,
  runInsert: /INSERT INTO admin_connector_test_runs/,
} as const;

function indexOf(calls: Array<{ sql: string }>, pattern: RegExp): number {
  return calls.findIndex((call) => pattern.test(call.sql));
}

/** The reservation harness: one scripted transaction, no provider, no audit store. */
function reservation(answers: Array<{ match: RegExp; rows: Record<string, unknown>[] }>) {
  const fake = fakeDb([
    ...answers,
    { match: /FROM admin_connector_test_runs r\b/, rows: [] },
    { match: /FROM profile_active_revisions/, rows: [{ profile_id: PROFILE_ID }] },
    { match: /FROM business_versions/, rows: [{ version: '1.0.0' }] },
    { match: ORDER.rate, rows: [{ recent: 0, active: 0 }] },
  ]);
  const record = jest.fn(async () => undefined);
  const ctx = {
    db: { tx: async (work: (client: unknown) => Promise<unknown>) => work(fake.db) },
    audit: { record },
    correlationId: 'pc-r05-finding-2',
  } as unknown as RouteContext;
  const request = {
    tenantId: TENANT_ID,
    apiKeyId: API_KEY_ID,
    profileId: PROFILE_ID,
    expectedProfileRevision: 2,
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    endpointSlug: 'extract',
    connectorId: 'connector-a',
    revision: 2,
    artifactIds: [],
  };
  const admitted = {
    profileId: PROFILE_ID,
    profileRevision: 2,
    bindingSlot: 'reasoning',
    profilePolicySnapshot: { parameters: {} },
    endpointSlug: 'extract',
  };
  const call = () => reserveProviderTestRun(ctx, bearerAuth, request as never, admitted as never, {
    expectedHash: 'a'.repeat(64),
    idempotencyHash: 'b'.repeat(64),
    invocationId: 'invocation-1',
    operationId: 'operation-1',
    taskId: 'task-1',
    reservationGroupId: 'reservation-1',
    deadlineAt: '2030-01-01T00:00:00.000Z',
  });
  return { call, calls: fake.calls, record };
}

const managedPreflight = { match: ORDER.preflight, rows: [{ key_mode: 'GROUP_MANAGED' }] };
const legacyPreflight = { match: ORDER.preflight, rows: [{ key_mode: 'LEGACY_STANDALONE' }] };

const rootLocked = { match: ORDER.root, rows: [{ group_id: GROUP_ID }] };

describe('PC-R05 Finding 2 — the reservation locks group root before the key', () => {
  it('takes preflight → root → key → grant, then the rate limit, then the run row', async () => {
    const { call, calls } = reservation([
      managedPreflight,
      rootLocked,
      { match: ORDER.key, rows: [{ id: API_KEY_ID, key_mode: 'GROUP_MANAGED' }] },
      { match: ORDER.grant, rows: [{ '?column?': 1 }] },
    ]);
    await expect(call()).resolves.toEqual({ existing: null });
    const preflight = indexOf(calls, ORDER.preflight);
    const root = indexOf(calls, ORDER.root);
    const key = indexOf(calls, ORDER.key);
    const grant = indexOf(calls, ORDER.grant);
    const rate = indexOf(calls, ORDER.rate);
    const runInsert = indexOf(calls, ORDER.runInsert);
    expect([preflight, root, key, grant, rate, runInsert].every((index) => index > -1)).toBe(true);
    expect(root).toBeGreaterThan(preflight);
    expect(key).toBeGreaterThan(root);
    expect(grant).toBeGreaterThan(key);
    expect(rate).toBeGreaterThan(grant);
    expect(runInsert).toBeGreaterThan(rate);
    // The preflight decides that a root is involved; it must not itself lock,
    // otherwise the order would still be key-first for every later statement.
    expect(calls[preflight]!.sql).not.toMatch(/FOR (SHARE|UPDATE)/);
    expect(calls[preflight]!.sql).toContain('FROM api_keys k');
    // Finding 2 also requires the managed path to authorize through the root
    // grant alone: a tombstoned child membership must not be consulted.
    expect(calls.some((call) => call.sql.includes('profile_api_keys'))).toBe(false);
  });

  it('locks every root the key is granted by, with FOR SHARE', async () => {
    const { call, calls } = reservation([
      managedPreflight,
      rootLocked,
      { match: ORDER.key, rows: [{ id: API_KEY_ID, key_mode: 'GROUP_MANAGED' }] },
      { match: ORDER.grant, rows: [{ '?column?': 1 }] },
    ]);
    await call();
    const rootCall = calls[indexOf(calls, ORDER.root)]!;
    expect(rootCall.sql).toContain('FOR SHARE OF grp');
    expect(rootCall.sql).toContain("g.state='ACTIVE'");
    expect(rootCall.params).toEqual([API_KEY_ID, TENANT_ID]);
  });
});

describe('PC-R05 Finding 2 — a missing grant denies before rate limit or run row', () => {
  it('denies a key whose grants are all revoked, before the key lock is taken', async () => {
    // No root answer ⇒ the root lock finds no ACTIVE grant for this key.
    const { call, calls } = reservation([managedPreflight]);
    await expect(call()).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(indexOf(calls, ORDER.root)).toBeGreaterThan(-1);
    expect(indexOf(calls, ORDER.key)).toBe(-1);
    expect(indexOf(calls, ORDER.rate)).toBe(-1);
    expect(indexOf(calls, ORDER.runInsert)).toBe(-1);
  });

  it('denies a grant revoked between the preflight and the lock, before the rate limit', async () => {
    const { call, calls, record } = reservation([
      managedPreflight,
      rootLocked,
      { match: ORDER.key, rows: [{ id: API_KEY_ID, key_mode: 'GROUP_MANAGED' }] },
      // The grant row is gone / no longer ACTIVE: the member pin does not resolve.
      { match: ORDER.grant, rows: [] },
    ]);
    await expect(call()).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(indexOf(calls, ORDER.grant)).toBeGreaterThan(-1);
    expect(indexOf(calls, ORDER.rate)).toBe(-1);
    expect(indexOf(calls, ORDER.runInsert)).toBe(-1);
    expect(record).not.toHaveBeenCalled();
  });

  it('denies a managed pointer whose group root vanished, before the key lock', async () => {
    const { call, calls } = reservation([
      managedPreflight,
      { match: ORDER.root, rows: [] },
    ]);
    await expect(call()).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(indexOf(calls, ORDER.key)).toBe(-1);
    expect(indexOf(calls, ORDER.rate)).toBe(-1);
  });
});

describe('PC-R05 Finding 2 — authority shape is re-read under the key lock', () => {
  it('fails closed when the key was converted after the preflight', async () => {
    const { call, calls } = reservation([
      managedPreflight,
      rootLocked,
      { match: ORDER.key, rows: [{ id: API_KEY_ID, key_mode: 'LEGACY_STANDALONE' }] },
    ]);
    await expect(call()).rejects.toMatchObject({ status: 409, code: 'ADMISSION_CHANGED' });
    expect(indexOf(calls, ORDER.grant)).toBe(-1);
    expect(indexOf(calls, ORDER.rate)).toBe(-1);
  });

  it('refuses an undeclared mode before taking any lock', async () => {
    const { call, calls } = reservation([{ match: ORDER.preflight, rows: [{ key_mode: null, group_id: null }] }]);
    await expect(call()).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    // The preflight is the last statement issued: no root, no key, no rate.
    expect(calls.at(-1)!.sql).toContain('SELECT k.key_mode');
    expect(indexOf(calls, ORDER.root)).toBe(-1);
    expect(indexOf(calls, ORDER.key)).toBe(-1);
    expect(indexOf(calls, ORDER.rate)).toBe(-1);
  });

  it('rejects an inactive or protected key as ADMISSION_REJECTED, as before', async () => {
    const { call, calls } = reservation([{ match: ORDER.preflight, rows: [] }]);
    await expect(call()).rejects.toMatchObject({ status: 409, code: 'ADMISSION_REJECTED' });
    expect(indexOf(calls, ORDER.rate)).toBe(-1);
  });
});

describe('PC-R05 Finding 2 — legacy keys never take the group root', () => {
  it('keeps the child-membership path, with no root lock', async () => {
    const { call, calls } = reservation([
      legacyPreflight,
      { match: ORDER.key, rows: [{ id: API_KEY_ID, key_mode: 'LEGACY_STANDALONE' }] },
      { match: ORDER.membership, rows: [{ '?column?': 1 }] },
    ]);
    await expect(call()).resolves.toEqual({ existing: null });
    expect(indexOf(calls, ORDER.root)).toBe(-1);
    expect(indexOf(calls, ORDER.grant)).toBe(-1);
    const key = indexOf(calls, ORDER.key);
    const membership = indexOf(calls, ORDER.membership);
    expect(membership).toBeGreaterThan(key);
    expect(indexOf(calls, ORDER.rate)).toBeGreaterThan(membership);
  });

  it('denies a legacy key without an active child membership before the rate limit', async () => {
    const { call, calls } = reservation([
      legacyPreflight,
      { match: ORDER.key, rows: [{ id: API_KEY_ID, key_mode: 'LEGACY_STANDALONE' }] },
      { match: ORDER.membership, rows: [] },
    ]);
    await expect(call()).rejects.toMatchObject({ status: 409, code: 'ADMISSION_CHANGED' });
    expect(indexOf(calls, ORDER.rate)).toBe(-1);
    expect(indexOf(calls, ORDER.runInsert)).toBe(-1);
  });
});

describe('PC-R05 Finding 2 — the seam itself is usable in isolation', () => {
  it('returns the mode once the authority prefix is locked', async () => {
    const db = fakeDb([
      managedPreflight,
      rootLocked,
      { match: ORDER.key, rows: [{ id: API_KEY_ID, key_mode: 'GROUP_MANAGED' }] },
      { match: ORDER.grant, rows: [{ '?column?': 1 }] },
    ]);
    await expect(lockProviderTestAuthority(db.db as never, {
      tenantId: TENANT_ID,
      apiKeyId: API_KEY_ID,
      profileId: PROFILE_ID,
      profileRevision: 2,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'extract',
    })).resolves.toBe('GROUP_MANAGED');
  });
});
// ---------------------------------------------------------------------------
// Finding 2 — provider-test admission for GROUP_MANAGED keys
// ---------------------------------------------------------------------------
describe('PC-R05 Finding 2 — provider-test admission authorizes managed keys by root grant', () => {
  const KEY = '44444444-4444-4444-8444-444444444444';
  const TENANT = '55555555-5555-4555-8555-555555555555';
  const GROUP = '66666666-6666-4666-8666-666666666666';
  const CHILD = '77777777-7777-4777-8777-777777777777';

  const manifest = {
    businessId: 'pc09-core',
    version: '1.0.0',
    runtime: { handlerKinds: ['root'] },
    actions: [{
      name: 'extract',
      inputSchema: { type: 'object', additionalProperties: true },
      connectorSlots: [{ name: 'reasoning' }],
    }],
  };

  const admissionInput = {
    tenantId: TENANT,
    apiKeyId: KEY,
    profileId: CHILD,
    expectedProfileRevision: 1,
    businessId: 'pc09-core',
    businessVersion: '1.0.0',
    action: 'extract',
    endpointSlug: 'extract:default',
    connectorId: 'connector-a',
    parameters: { note: 'probe' },
    artifactIds: [] as string[],
  };

  function memberRow() {
    return {
      group_id: GROUP,
      tenant_id: TENANT,
      group_revision: 1,
      auth_authority: 'GROUP_GRANT',
      access_version: 7,
      business_id: 'pc09-core',
      business_version: '1.0.0',
      manifest_digest: 'sha256:test',
      function_kind: 'endpoint',
      function_id: 'extract:default',
      action: 'extract',
      endpoint_slug: 'extract:default',
      workflow_revision: null,
      profile_id: CHILD,
      binding_revision: 1,
      enabled: true,
      parameters: {},
      request_defaults: {},
      connector_bindings: { reasoning: { connectorId: 'connector-a', revision: 2 } },
      job_priority: null,
      allowed_file_extensions: '',
      connections_override: null,
      file_url_auth_cipher: null,
      callback_policy: null,
      allowed_origins: null,
      profile_name: 'child',
      group_owned: true,
    };
  }

  function world(options: { grant: boolean }) {
    const resolveEffectiveProfile = jest.fn(async () => {
      throw new Error('the legacy child-membership resolver must not run for a GROUP_MANAGED key');
    });
    const db = fakeDb([
      { match: /SELECT id, key_mode FROM api_keys/, rows: [{ id: KEY, key_mode: 'GROUP_MANAGED' }] },
      { match: /FROM business_catalog/, rows: [{ enabled: true, activation_revision: 1, submissions_paused: false, pre_drain_version: null }] },
      { match: /FROM business_versions/, rows: [{ version: '1.0.0', manifest, digest: 'sha256:test', queue: 'q', status: 'ENABLED' }] },
      { match: /SELECT id, tenant_id, status, key_mode FROM api_keys/, rows: [{ id: KEY, tenant_id: TENANT, status: 'ACTIVE', key_mode: 'GROUP_MANAGED' }] },
      {
        match: /FROM profile_group_api_keys g/,
        rows: options.grant
          ? [{ group_id: GROUP, tenant_id: TENANT, access_version: 7, granted_at: '2026-01-01T00:00:00.000Z' }]
          : [],
      },
      { match: /FROM profile_groups WHERE group_id=/, rows: [{ group_id: GROUP, tenant_id: TENANT, auth_authority: 'GROUP_GRANT', access_version: 7, active_revision: 1 }] },
      { match: /FROM profile_groups g\s+JOIN profile_group_members m/, rows: options.grant ? [memberRow()] : [] },
      { match: /SELECT k.name,k.spending_limit/, rows: [{ name: 'key', spending_limit: '0', total_used: '0', tenant_id: TENANT }] },
    ]);
    const submission = createSubmissionService(
      db.db as unknown as Parameters<typeof createSubmissionService>[0],
      {} as never,
      { resolveEffectiveProfile } as never,
      {},
    );
    return { submission, resolveEffectiveProfile, calls: db.calls };
  }

  it('admits a GROUP_MANAGED key through its active root grant and child pin', async () => {
    const { submission, resolveEffectiveProfile } = world({ grant: true });
    const admission = await submission.admitProviderTest(admissionInput);

    expect(admission.profileId).toBe(CHILD);
    expect(admission.profileRevision).toBe(1);
    expect(admission.bindingSlot).toBe('reasoning');
    expect(admission.connectorBindings).toMatchObject({ reasoning: { connectorId: 'connector-a', revision: 2 } });
    // The legacy resolver would deny a managed key outright: it must not run.
    expect(resolveEffectiveProfile).not.toHaveBeenCalled();
  });

  it('denies a GROUP_MANAGED key with no active root grant before any reservation', async () => {
    const { submission, resolveEffectiveProfile } = world({ grant: false });
    // The group plane's own denial code: a managed key with no live grant is
    // unauthorized, never "not assigned" (which would be the legacy resolver).
    await expect(submission.admitProviderTest(admissionInput)).rejects.toMatchObject({
      status: 403,
      code: 'PROFILE_GROUP_UNAUTHORIZED',
      message: 'no active profile-group grant authorizes this API key',
    });
    expect(resolveEffectiveProfile).not.toHaveBeenCalled();
  });

  it('denies when the selected child pin is not the granted one', async () => {
    const { submission } = world({ grant: true });
    await expect(submission.admitProviderTest({ ...admissionInput, profileId: '88888888-8888-4888-8888-888888888888' }))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('denies when the expected profile revision no longer matches the pin', async () => {
    const { submission } = world({ grant: true });
    await expect(submission.admitProviderTest({ ...admissionInput, expectedProfileRevision: 2 }))
      .rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });
  });
});