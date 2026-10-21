import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { ProfileGroupSaveSchema, type BusinessManifest, type ProfileGroup, type ProfileGroupSave } from '@du/contracts';
import { createApp, type App } from '../src/server';
import { generateSchemaSetupDdl, generateSchemaTeardownDdl, createTestIsolationContext, assertSafeIsolationConfig, type TestIsolationContext } from '../../../../tests/isolation/namespace';
import { getProfileGroup, rollbackProfileGroup, saveProfileGroup } from '../src/modules/profiles/profile-groups';
import { createAdminIdentityService } from '../src/modules/identity/service';
import { createProfileSelfServiceService } from '../src/modules/profiles/self-service';
import { handleProfileGroupsRoute, matchProfileGroupsRoute } from '../src/app/admin/bff/profile-groups';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import type { BffRuntimeConfig } from '../src/app/admin/bff/upstream';

const LIVE = process.env.DU_LIVE_INFRA === '1' && process.env.VFY_WOC_LIVE === '1';
const liveDescribe: typeof describe = LIVE ? describe : describe.skip;

interface Barrier {
  wait(): Promise<void>;
  firstHit: Promise<void>;
  release(): void;
  readonly hits: number;
}

function createBarrier(targetHits: number, timeoutMs: number): Barrier {
  let hits = 0;
  let resolveFirst!: () => void;
  let resolveGate!: () => void;
  let released = false;
  const firstHit = new Promise<void>((resolve) => { resolveFirst = resolve; });
  const gatePromise = new Promise<void>((resolve) => { resolveGate = resolve; });
  const timer = setTimeout(() => release(), timeoutMs);
  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    resolveGate();
  };
  return {
    firstHit,
    release,
    get hits() { return hits; },
    async wait() {
      hits += 1;
      if (hits === 1) resolveFirst();
      if (hits >= targetHits) release();
      await gatePromise;
    },
  };
}

function pauseAfterQuery(
  client: PoolClient,
  predicate: (sql: string) => boolean,
  barrier: Barrier,
  onQueryComplete?: (sql: string, client: PoolClient) => Promise<void>,
): PoolClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
      return async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await target.query<T>(sql, values as never);
        await onQueryComplete?.(sql, target);
        if (predicate(sql)) await barrier.wait();
        return result;
      };
    },
  }) as PoolClient;
}

async function waitForSignal(signal: Promise<void>, label: string, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeManifest(businessId: string): BusinessManifest {
  return {
    contractVersion: '1',
    businessId,
    version: '1.0.0',
    displayName: 'WOC Independent Verification',
    description: 'Isolated profile group verification business',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtime: { wireVersion: '1', handlerKinds: ['root'] },
    capabilities: { cancel: true, resume: true, parallel: true },
    actions: [{
      name: 'extract',
      displayName: 'Extract',
      description: 'Independent profile invariant fixture',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 1 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: {},
    }],
  };
}

function groupInput(
  tenantId: string,
  apiKeyId: string,
  businessId: string,
  manifestDigest: string,
  name: string,
  expectedRevision = 0,
  businessVersion = '1.0.0',
): ProfileGroupSave {
  return ProfileGroupSaveSchema.parse({
    name,
    tenantId,
    apiKey: { apiKeyId },
    expectedRevision,
    businesses: [{
      businessId,
      businessVersion,
      manifestDigest,
      functions: [{
        kind: 'workflow',
        functionId: 'extract',
        action: 'extract',
        policy: {},
        connectorBindings: {},
      }],
    }],
  });
}

describe('WOC independent real-PostgreSQL profile invariants', () => {
  let app: App | undefined;
  let isolation: TestIsolationContext | undefined;
  let businessId: string;
  let tenantId: string;
  let manifestDigest: string;
  let internalBaseUrl: string;
  let adminToken: string;

  beforeAll(async () => {
    if (!LIVE) return;
    const databaseUrl = process.env.DATABASE_URL;
    const redisUrl = process.env.REDIS_URL;
    if (!databaseUrl || !redisUrl || !process.env.TEST_RUN_ID) {
      throw new Error('live WOC profile tests require DATABASE_URL, REDIS_URL and TEST_RUN_ID');
    }
    isolation = createTestIsolationContext({
      runId: process.env.TEST_RUN_ID,
      redisDbIndex: 2,
      baseArtifactPath: join(tmpdir(), 'du-vfy-woc-artifacts'),
    });
    assertSafeIsolationConfig({
      databaseUrl: isolation.getDatabaseUrlWithSchema(databaseUrl),
      redisUrl,
      isolationCtx: isolation,
    });
    const parsedDb = new URL(databaseUrl);
    const parsedRedis = new URL(redisUrl);
    if (!parsedDb.pathname.endsWith('_test') || parsedDb.hostname !== '127.0.0.1') {
      throw new Error('live WOC profile tests require a loopback PostgreSQL database ending in _test');
    }
    if (parsedRedis.hostname !== '127.0.0.1' || parsedRedis.port !== process.env.TEST_REDIS_PORT) {
      throw new Error('live WOC profile tests require the explicitly allowed loopback Redis port');
    }

    const adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(generateSchemaSetupDdl(isolation.dbSchema));
    await adminPool.end();

    businessId = `woc-vfy-${randomUUID().slice(0, 8)}`;
    tenantId = isolation.tenantId;
    const manifest = makeManifest(businessId);
    const runtimeToken = `vfy-runtime-${randomUUID()}`;
    adminToken = `vfy-admin-${randomUUID()}`;
    app = await createApp({
      port: 0,
      host: '127.0.0.1',
      internalPort: 0,
      internalHost: '127.0.0.1',
      databaseUrl: isolation.getDatabaseUrlWithSchema(databaseUrl),
      redisUrl,
      runtimeToken,
      workerIdentityTokensByBusiness: { [businessId]: `vfy-worker-${randomUUID()}` },
      adminToken,
      invocationGrantSecret: `vfy-grant-${randomUUID()}`,
      autoDispatch: false,
      autoMigrate: true,
      encryptionPolicy: {
        dataMode: 'synthetic',
        metadataEncryption: false,
        publicUploadEncryption: false,
        metadataPlaintextReadMode: 'none',
        profileCipherKeyPresent: false,
      },
    });
    await app.listen();
    const internalAddress = app.internalServer.address() as { port: number };
    internalBaseUrl = `http://127.0.0.1:${internalAddress.port}`;

    await app.db.query(
      `INSERT INTO tenants (id,name) VALUES ($1,'WOC independent verifier') ON CONFLICT (id) DO NOTHING`,
      [tenantId],
    );
    const registration = await app.registry.registerVersion(manifest);
    manifestDigest = registration.digest;
    const lifecycle = await app.db.query<{ lifecycle_revision: number | string }>(
      'SELECT lifecycle_revision FROM business_catalog WHERE business_id=$1',
      [businessId],
    );
    await app.registry.setBusinessEnabled(businessId, true, Number(lifecycle.rows[0]!.lifecycle_revision));
    await app.enableVersionForTest(businessId, '1.0.0');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (isolation && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl) {
        const adminPool = new Pool({ connectionString: databaseUrl });
        try {
          await adminPool.query(generateSchemaTeardownDdl(isolation.dbSchema));
        } finally {
          await adminPool.end();
        }
      }
    }
    isolation?.cleanupArtifactDir();
  }, 30_000);

  async function newKey(label: string): Promise<{ id: string; raw: string }> {
    const id = randomUUID();
    const raw = `du_vfy_${label}_${randomUUID().replaceAll('-', '')}`;
    const hash = createHash('sha256').update(raw).digest('hex');
    await app!.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status, key_mode) VALUES ($1,$2,$3,$4,'ACTIVE', 'LEGACY_STANDALONE')`,
      [id, tenantId, hash, `vfy_${label}`],
    );
    return { id, raw };
  }

  async function ensureBusinessEnabled(): Promise<void> {
    const result = await app!.db.query<{ enabled: boolean; lifecycle_revision: number | string }>(
      'SELECT enabled,lifecycle_revision FROM business_catalog WHERE business_id=$1',
      [businessId],
    );
    const row = result.rows[0];
    if (row && !row.enabled) {
      await app!.registry.setBusinessEnabled(businessId, true, Number(row.lifecycle_revision));
    }
  }

  async function saveNewGroup(input: ProfileGroupSave) {
    return app!.db.tx((client) => saveProfileGroup(
      client,
      app!.profiles,
      app!.connectorManagement,
      input,
      null,
      tenantId,
    ));
  }

  async function registerSecondVersion(): Promise<string> {
    const manifest = makeManifest(businessId);
    manifest.version = '2.0.0';
    const registration = await app!.registry.registerVersion(manifest);
    await app!.enableVersionForTest(businessId, '2.0.0');
    return registration.digest;
  }

  async function postAdminAction(action: string, params: Record<string, unknown>) {
    const response = await fetch(`${internalBaseUrl}/api/v1/admin/actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, params }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  liveDescribe('real PostgreSQL races and group-owned child boundaries', () => {
    it('serializes concurrent group overlap checks for the same key and function', async () => {
      await ensureBusinessEnabled();
      const key = await newKey('overlap');
      const barrier = createBarrier(2, 1_500);
      const isOverlapCheck = (sql: string): boolean =>
        /FROM\s+profile_active_revisions\s+a/i.test(sql)
        && /JOIN\s+profile_api_keys/i.test(sql);
      const saveAtBarrier = (name: string) => app!.db.tx((client) => saveProfileGroup(
        pauseAfterQuery(client, isOverlapCheck, barrier),
        app!.profiles,
        app!.connectorManagement,
        groupInput(tenantId, key.id, businessId, manifestDigest, name),
        null,
        tenantId,
      ));

      const outcomes = await Promise.allSettled([
        saveAtBarrier(`parallel-a-${randomUUID()}`),
        saveAtBarrier(`parallel-b-${randomUUID()}`),
      ]);
      barrier.release();
      const active = await app!.db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM profile_active_revisions a
           JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
           JOIN profile_api_keys m ON m.profile_id=p.profile_id AND m.state='ACTIVE'
          WHERE m.api_key_id=$1 AND p.business_id=$2 AND p.business_version='1.0.0'
            AND p.action='extract'`,
        [key.id, businessId],
      );
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;

      // At most one active key/function binding may survive even when
      // independent transactions reach the overlap point together.
      expect(barrier.hits).toBeGreaterThanOrEqual(1);
      expect(fulfilled).toBe(1);
      expect(Number(active.rows[0]!.count)).toBe(1);
    }, 15_000);

    it('keeps business disable ordered after a group transaction that admitted the version', async () => {
      await ensureBusinessEnabled();
      const key = await newKey('disable-race');
      // One transaction waits here; require a second hit to prevent the
      // single-participant barrier from releasing itself before disable races it.
      const barrier = createBarrier(2, 20_000);
      const isCatalogRead = (sql: string): boolean =>
        /FROM\s+business_versions\s+v/i.test(sql)
        && /JOIN\s+business_catalog\s+c/i.test(sql);
      const order: string[] = [];
      const sqlOrder: string[] = [];
      let groupBackend: { pid: number; xid: string } | undefined;
      const savePromise = app!.db.tx((client) => saveProfileGroup(
        pauseAfterQuery(client, isCatalogRead, barrier, async (sql, txClient) => {
          if (/FROM\s+business_catalog\s+WHERE\s+business_id=\$1\s+FOR\s+SHARE/i.test(sql)) {
            sqlOrder.push('group catalog root FOR SHARE completed');
          }
          if (isCatalogRead(sql)) {
            sqlOrder.push('group version/catalog JOIN completed; barrier entered');
            const identity = await txClient.query<{ pid: number; xid: string }>(
              'SELECT pg_backend_pid() AS pid, txid_current()::text AS xid',
            );
            groupBackend = identity.rows[0];
          }
        }),
        app!.profiles,
        app!.connectorManagement,
        groupInput(
          tenantId,
          key.id,
          businessId,
          manifestDigest,
          `disable-race-${randomUUID()}`,
        ),
        null,
        tenantId,
      )).then((value) => {
        order.push('group-committed');
        return value;
      });
      await barrier.firstHit;

      const lifecycle = await app!.db.query<{ lifecycle_revision: number | string }>(
        'SELECT lifecycle_revision FROM business_catalog WHERE business_id=$1',
        [businessId],
      );
      let disableBackendPid: number | undefined;
      app!.db.pool.once('acquire', (client) => {
        disableBackendPid = (client as unknown as { processID?: number }).processID;
      });
      sqlOrder.push('registry.setBusinessEnabled(false) called');
      const disablePromise = app!.registry.setBusinessEnabled(
        businessId,
        false,
        Number(lifecycle.rows[0]!.lifecycle_revision),
      ).then((value) => {
        order.push('business-disabled');
        sqlOrder.push('setBusinessEnabled returned after db.tx commit');
        return value;
      });
      const disableFinishedBeforeGroupRelease = await Promise.race([
        disablePromise.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      sqlOrder.push(disableFinishedBeforeGroupRelease
        ? 'disable promise settled before group barrier release'
        : 'disable promise still pending at 250ms barrier check');
      const catalogDuringGroupPause = await app!.db.query<{ enabled: boolean }>(
        'SELECT enabled FROM business_catalog WHERE business_id=$1',
        [businessId],
      );
      sqlOrder.push(`separate catalog read while paused enabled=${String(catalogDuringGroupPause.rows[0]?.enabled)}`);
      const backendPids = [groupBackend?.pid, disableBackendPid].filter((pid): pid is number => typeof pid === 'number');
      const activity = backendPids.length ? await app!.db.query<{
        pid: number;
        backend_xid: string | null;
        state: string;
        wait_event_type: string | null;
        wait_event: string | null;
        query: string;
      }>(
        `SELECT pid,backend_xid::text,state,wait_event_type,wait_event,left(query,180) AS query
           FROM pg_stat_activity WHERE pid=ANY($1::int[]) ORDER BY pid`,
        [backendPids],
      ) : { rows: [] };
      const locks = backendPids.length ? await app!.db.query<{
        pid: number;
        locktype: string;
        mode: string;
        granted: boolean;
        relation: string | null;
        transaction_id: string | null;
      }>(
        `SELECT pid,locktype,mode,granted,relation::regclass::text AS relation,transactionid::text AS transaction_id
           FROM pg_locks
          WHERE pid=ANY($1::int[])
            AND (relation=to_regclass('business_catalog') OR locktype='transactionid')
          ORDER BY pid,locktype,mode`,
        [backendPids],
      ) : { rows: [] };
      console.info(`[VFY-WOC] profile disable/save evidence=${JSON.stringify({
        businessId,
        groupBackend,
        disableBackendPid,
        sqlOrder,
        activity: activity.rows,
        locks: locks.rows,
      })}`);
      barrier.release();
      sqlOrder.push('group barrier released');
      const [group, disabled] = await Promise.all([savePromise, disablePromise]);
      sqlOrder.push('both promises settled');

      expect(group.revision).toBe(1);
      expect({
        enabledDuringGroupPause: catalogDuringGroupPause.rows[0]?.enabled,
        returnedEnabled: disabled.enabled,
        disableFinishedBeforeGroupRelease,
        order,
      }).toEqual({
        enabledDuringGroupPause: true,
        returnedEnabled: false,
        disableFinishedBeforeGroupRelease: false,
        order: ['group-committed', 'business-disabled'],
      });
    }, 30_000);

    it('blocks the legacy admin binding route from mutating a group-owned child', async () => {
      await ensureBusinessEnabled();
      const key = await newKey('direct-child');
      const group = await saveNewGroup(groupInput(
        tenantId,
        key.id,
        businessId,
        manifestDigest,
        `direct-child-${randomUUID()}`,
      ));
      const childProfileId = group.businesses[0]!.functions[0]!.childProfileId;
      const response = await fetch(`${internalBaseUrl}/api/v1/admin/profile-bindings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          profileId: childProfileId,
          apiKey: key.raw,
          businessId,
          businessVersion: '1.0.0',
          action: 'extract',
          connectorBindings: {},
        }),
      });
      const responseBody = await response.json() as Record<string, unknown>;
      const pointer = await app!.db.query<{ revision: number | string }>(
        'SELECT revision FROM profile_active_revisions WHERE profile_id=$1',
        [childProfileId],
      );

      if (response.status === 404) {
        const code = typeof responseBody.code === 'string' ? responseBody.code : 'unknown';
        const detail = typeof responseBody.detail === 'string' ? responseBody.detail : 'unknown';
        throw new Error(`legacy binding route returned 404 before guard: code=${code}; detail=${detail}`);
      }
      expect({ status: response.status, revision: Number(pointer.rows[0]!.revision), body: responseBody })
        .toMatchObject({ status: 409, revision: 1 });
    }, 15_000);

    it('rejects a legacy rollback whose target selector overlaps a group created after the active revision moved', async () => {
      await ensureBusinessEnabled();
      const key = await newKey('rollback-overlap');
      const profileName = `rollback-overlap-${randomUUID()}`;
      const firstSaveResponse = await fetch(`${internalBaseUrl}/api/v1/admin/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'profile.upsert',
          params: {
            apiKey: { apiKeyId: key.id },
            businessId,
            businessVersion: '1.0.0',
            profileName,
            action: 'extract',
            expectedRevision: 0,
            connectorBindings: {},
            policy: {},
          },
        }),
      });
      const firstSaveBody = await firstSaveResponse.json() as { profileId?: string; revision?: number };
      expect(firstSaveResponse.status).toBe(201);
      expect(firstSaveBody).toMatchObject({ revision: 1 });

      const secondManifest = makeManifest(businessId);
      secondManifest.version = '2.0.0';
      const secondRegistration = await app!.registry.registerVersion(secondManifest);
      await app!.enableVersionForTest(businessId, '2.0.0');
      await app!.profiles.createRevision({
        profileId: firstSaveBody.profileId!,
        apiKeyHash: createHash('sha256').update(key.raw).digest('hex'),
        businessId,
        businessVersion: '2.0.0',
        action: 'extract',
        connectorBindings: {},
        policy: {},
      });
      const pointerBeforeGroupRollback = await app!.db.query<{ revision: number | string }>(
        'SELECT revision FROM profile_active_revisions WHERE profile_id=$1',
        [firstSaveBody.profileId],
      );
      const group = await saveNewGroup(groupInput(
        tenantId,
        key.id,
        businessId,
        manifestDigest,
        `rollback-overlap-group-${randomUUID()}`,
      ));

      const rollbackResponse = await fetch(`${internalBaseUrl}/api/v1/admin/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'profile.rollback',
          params: {
            apiKey: { apiKeyId: key.id },
            businessId,
            businessVersion: '1.0.0',
            profileName,
            action: 'extract',
            targetRevision: 1,
            expectedRevision: 2,
          },
        }),
      });
      const rollbackBody = await rollbackResponse.json() as { code?: string; revision?: number };
      const pointerAfter = await app!.db.query<{ revision: number | string }>(
        'SELECT revision FROM profile_active_revisions WHERE profile_id=$1',
        [firstSaveBody.profileId],
      );
      const overlapCount = await app!.db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM profile_active_revisions a
           JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
           JOIN profile_api_keys m ON m.profile_id=p.profile_id AND m.api_key_id=$1 AND m.state='ACTIVE'
          WHERE p.business_id=$2 AND p.business_version='1.0.0' AND p.action='extract'`,
        [key.id, businessId],
      );
      const storedGroup = await getProfileGroup(app!.db, group.groupId, tenantId);
      const safeOutcome = {
        secondVersionDigestMatches: secondRegistration.digest.length > 0,
        activePointerBeforeGroupRollback: Number(pointerBeforeGroupRollback.rows[0]?.revision),
        rollbackStatus: rollbackResponse.status,
        rollbackCode: rollbackBody.code,
        activePointerAfter: Number(pointerAfter.rows[0]?.revision),
        overlappingActiveSelectors: Number(overlapCount.rows[0]?.count),
        groupRevision: storedGroup.revision,
      };
      console.info(`[VFY-WOC] legacy target-selector rollback evidence=${JSON.stringify(safeOutcome)}`);

      expect(safeOutcome).toEqual({
        secondVersionDigestMatches: true,
        activePointerBeforeGroupRollback: 2,
        rollbackStatus: 409,
        rollbackCode: 'STATE_CONFLICT',
        activePointerAfter: 2,
        overlappingActiveSelectors: 1,
        groupRevision: 1,
      });
    }, 20_000);

    it('rejects publishing a legacy latest revision whose selector overlaps an existing group', async () => {
      await ensureBusinessEnabled();
      const secondDigest = await registerSecondVersion();
      const key = await newKey('publish-target-overlap');
      const profileName = `publish-target-overlap-${randomUUID()}`;
      const firstSave = await postAdminAction('profile.upsert', {
        apiKey: { apiKeyId: key.id },
        businessId,
        businessVersion: '1.0.0',
        profileName,
        action: 'extract',
        expectedRevision: 0,
        connectorBindings: {},
        policy: {},
      });
      expect(firstSave.status).toBe(201);
      const profileId = String(firstSave.body.profileId);
      await app!.profiles.createRevision({
        profileId,
        apiKeyHash: createHash('sha256').update(key.raw).digest('hex'),
        businessId,
        businessVersion: '2.0.0',
        action: 'extract',
        connectorBindings: {},
        policy: {},
      });
      await app!.db.query(
        'UPDATE profile_active_revisions SET revision=1,moved_at=now() WHERE profile_id=$1',
        [profileId],
      );
      const group = await saveNewGroup(groupInput(
        tenantId,
        key.id,
        businessId,
        secondDigest,
        `publish-target-group-${randomUUID()}`,
        0,
        '2.0.0',
      ));

      const publish = await postAdminAction('profile.publish', {
        apiKey: { apiKeyId: key.id },
        businessId,
        businessVersion: '1.0.0',
        profileName,
        action: 'extract',
        expectedRevision: 1,
      });
      const pointer = await app!.db.query<{ revision: number | string }>(
        'SELECT revision FROM profile_active_revisions WHERE profile_id=$1',
        [profileId],
      );
      const v2OverlapCount = await app!.db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM profile_active_revisions a
           JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
           JOIN profile_api_keys m ON m.profile_id=p.profile_id AND m.api_key_id=$1 AND m.state='ACTIVE'
          WHERE p.business_id=$2 AND p.business_version='2.0.0' AND p.action='extract'`,
        [key.id, businessId],
      );
      const storedGroup = await getProfileGroup(app!.db, group.groupId, tenantId);
      const resolved = await app!.profiles.resolveEffectiveProfile(
        key.id, businessId, '2.0.0', 'extract',
      );
      const outcome = {
        publishStatus: publish.status,
        publishCode: publish.body.code,
        pointerRevision: Number(pointer.rows[0]?.revision),
        targetSelectorCount: Number(v2OverlapCount.rows[0]?.count),
        groupRevision: storedGroup.revision,
        resolverProfileId: resolved.mode === 'pinned' ? resolved.profileId : resolved.mode,
      };
      console.info(`[VFY-WOC] legacy publish target-selector evidence=${JSON.stringify(outcome)}`);

      expect(outcome).toEqual({
        publishStatus: 409,
        publishCode: 'STATE_CONFLICT',
        pointerRevision: 1,
        targetSelectorCount: 1,
        groupRevision: 1,
        resolverProfileId: group.businesses[0]!.functions[0]!.childProfileId,
      });
    }, 20_000);

    it('rejects appending a legacy revision when another active member key already has the target selector', async () => {
      await ensureBusinessEnabled();
      const secondDigest = await registerSecondVersion();
      const keyOne = await newKey('append-member-one');
      const keyTwo = await newKey('append-member-two');
      const profileName = `append-member-${randomUUID()}`;
      const firstSave = await postAdminAction('profile.upsert', {
        apiKey: { apiKeyId: keyOne.id },
        businessId,
        businessVersion: '2.0.0',
        profileName,
        action: 'extract',
        expectedRevision: 0,
        connectorBindings: {},
        policy: {},
      });
      expect(firstSave.status).toBe(201);
      const profileId = String(firstSave.body.profileId);
      const attach = await postAdminAction('apikey.attach', { apiKeyId: keyTwo.id, profileId });
      expect(attach.status).toBe(201);
      const group = await saveNewGroup(groupInput(
        tenantId,
        keyTwo.id,
        businessId,
        manifestDigest,
        `append-target-group-${randomUUID()}`,
      ));
      const before = await app!.db.query<{
        revision: number | string;
        revisionCount: string;
        activeMembershipCount: string;
      }>(
        `SELECT a.revision,
                (SELECT count(*)::text FROM profile_bindings WHERE profile_id=a.profile_id) AS "revisionCount",
                (SELECT count(*)::text FROM profile_api_keys WHERE profile_id=a.profile_id AND state='ACTIVE') AS "activeMembershipCount"
           FROM profile_active_revisions a WHERE a.profile_id=$1`,
        [profileId],
      );

      let appendError: unknown;
      try {
        await app!.profiles.createRevision({
          profileId,
          apiKeyHash: createHash('sha256').update(keyOne.raw).digest('hex'),
          businessId,
          businessVersion: '1.0.0',
          action: 'extract',
          connectorBindings: {},
          policy: {},
        });
      } catch (error) {
        appendError = error;
      }
      const appendProblem = appendError && typeof appendError === 'object'
        ? appendError as { status?: unknown; code?: unknown }
        : {};
      const after = await app!.db.query<{
        revision: number | string;
        revisionCount: string;
        activeMembershipCount: string;
      }>(
        `SELECT a.revision,
                (SELECT count(*)::text FROM profile_bindings WHERE profile_id=a.profile_id) AS "revisionCount",
                (SELECT count(*)::text FROM profile_api_keys WHERE profile_id=a.profile_id AND state='ACTIVE') AS "activeMembershipCount"
           FROM profile_active_revisions a WHERE a.profile_id=$1`,
        [profileId],
      );
      const storedGroup = await getProfileGroup(app!.db, group.groupId, tenantId);
      const resolved = await app!.profiles.resolveEffectiveProfile(
        keyTwo.id, businessId, '1.0.0', 'extract',
      );
      const outcome = {
        appendStatus: appendProblem.status,
        appendCode: appendProblem.code,
        beforePointer: Number(before.rows[0]?.revision),
        afterPointer: Number(after.rows[0]?.revision),
        beforeRevisionCount: Number(before.rows[0]?.revisionCount),
        afterRevisionCount: Number(after.rows[0]?.revisionCount),
        beforeMembershipCount: Number(before.rows[0]?.activeMembershipCount),
        afterMembershipCount: Number(after.rows[0]?.activeMembershipCount),
        groupRevision: storedGroup.revision,
        resolverProfileId: resolved.mode === 'pinned' ? resolved.profileId : resolved.mode,
      };
      console.info(`[VFY-WOC] legacy cross-key append evidence=${JSON.stringify(outcome)}`);

      expect(outcome).toEqual({
        appendStatus: 409,
        appendCode: 'STATE_CONFLICT',
        beforePointer: 1,
        afterPointer: 1,
        beforeRevisionCount: 1,
        afterRevisionCount: 1,
        beforeMembershipCount: 2,
        afterMembershipCount: 2,
        groupRevision: 1,
        resolverProfileId: group.businesses[0]!.functions[0]!.childProfileId,
      });
    }, 20_000);

    it('rotates through the admin action, preserves assigned read policy, and edits/rolls back with the replacement key', async () => {
      await ensureBusinessEnabled();
      const oldKey = await newKey('rotation-old');
      const first = await saveNewGroup(groupInput(
        tenantId,
        oldKey.id,
        businessId,
        manifestDigest,
        `rotation-${randomUUID()}`,
      ));
      const childProfileIds = first.businesses.flatMap((business) => business.functions.map((fn) => fn.childProfileId));
      const localUserId = randomUUID();
      const passwordHash = `scrypt$32768$8$1$${randomBytes(16).toString('base64url')}$${randomBytes(32).toString('base64url')}`;
      await app!.db.query(
        `INSERT INTO admin_local_users (id,tenant_id,username_normalized,password_hash,role)
         VALUES ($1,$2,$3,$4,'operator')`,
        [localUserId, tenantId, `vfy-${randomUUID().slice(0, 12)}`, passwordHash],
      );
      await app!.db.query(
        `INSERT INTO admin_local_user_profile_grants (tenant_id,user_id,profile_id)
         SELECT $1,$2,profile_id FROM unnest($3::uuid[]) AS profile_id`,
        [tenantId, localUserId, childProfileIds],
      );
      await app!.db.query(
        `INSERT INTO admin_local_user_api_key_grants (tenant_id,user_id,api_key_id) VALUES ($1,$2,$3)`,
        [tenantId, localUserId, oldKey.id],
      );

      const localIdentity = createAdminIdentityService({
        db: app!.db,
        audit: {} as never,
        auth: { mode: 'local', localEnabled: true, oidc: null },
      });
      const profileSelfService = createProfileSelfServiceService({
        db: app!.db,
        profiles: app!.profiles,
        registry: app!.registry,
        audit: {} as never,
        identity: localIdentity,
      });
      const localSessionId = `vfy-session-${randomUUID()}`;
      const shellConfig = {
        oidcSessions: {
          async get(sessionId: string) {
            return sessionId === localSessionId ? {
              sessionId,
              issuer: 'du-local',
              sub: localUserId,
              tenantId,
              role: 'operator',
              csrfToken: randomBytes(32).toString('base64url'),
              roleVersion: 1,
            } : null;
          },
        },
      } as unknown as ShellRuntimeConfig;
      const bffRuntime: BffRuntimeConfig = {
        jsonBaseUrl: internalBaseUrl,
        tenantCredentialFor: (candidateTenantId) => candidateTenantId === tenantId ? adminToken : undefined,
        profileSelfService,
      };
      const callLocalGroup = async (method: 'GET' | 'PUT') => {
        let bodyText = '';
        const response = {
          statusCode: 0,
          setHeader() {},
          end(value?: string) { bodyText = value ?? ''; },
        };
        const request = {
          method,
          pathname: `/admin/api/profile-groups/${first.groupId}`,
          cookies: { du_session: localSessionId },
          body: {},
        } as unknown as AdminShellRequest;
        await handleProfileGroupsRoute(
          { method, headers: {} } as unknown as IncomingMessage,
          response as unknown as ServerResponse,
          request,
          matchProfileGroupsRoute(`/profile-groups/${first.groupId}`)!,
          new URLSearchParams(),
          shellConfig,
          bffRuntime,
          `vfy-local-group-${method.toLowerCase()}`,
        );
        return { status: response.statusCode, body: bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {} };
      };

      const replacementRaw = `du_vfy_rotation_${randomUUID().replaceAll('-', '')}`;
      const rotationResponse = await fetch(`${internalBaseUrl}/api/v1/admin/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'apikey.rotate',
          params: { apiKeyId: oldKey.id, apiKey: replacementRaw },
        }),
      });
      const rotationBody = await rotationResponse.json() as { apiKeyId?: string; revokedId?: string; status?: string };
      expect(rotationResponse.status).toBe(201);
      expect(rotationBody).toMatchObject({ revokedId: oldKey.id, status: 'ACTIVE' });
      const replacementKeyId = rotationBody.apiKeyId;
      expect(typeof replacementKeyId).toBe('string');

      const readWithoutReplacementGrant = await callLocalGroup('GET');
      await app!.db.query(
        `INSERT INTO admin_local_user_api_key_grants (tenant_id,user_id,api_key_id) VALUES ($1,$2,$3)`,
        [tenantId, localUserId, replacementKeyId],
      );
      const readWithReplacementGrant = await callLocalGroup('GET');
      const localWrite = await callLocalGroup('PUT');

      const edited = await fetch(`${internalBaseUrl}/api/v1/admin/profile-groups/${first.groupId}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(groupInput(
          tenantId,
          replacementKeyId!,
          businessId,
          manifestDigest,
          `${first.name} after rotation`,
          1,
        )),
      });
      const editedBody = await edited.json() as { revision?: number; apiKey?: { apiKeyId?: string } };
      const rolledBack = await fetch(`${internalBaseUrl}/api/v1/admin/profile-groups/${first.groupId}/rollback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ targetRevision: 1, expectedRevision: 2 }),
      });
      const rollbackBody = await rolledBack.json() as { revision?: number; apiKey?: { apiKeyId?: string } };
      const resolved = await app!.profiles.resolveEffectiveProfile(
        replacementKeyId!, businessId, '1.0.0', 'extract',
      );
      const readAfterRollback = await callLocalGroup('GET');
      const oldKeyState = await app!.db.query<{ status: string }>('SELECT status FROM api_keys WHERE id=$1', [oldKey.id]);

      console.info(`[VFY-WOC] profile key rotation evidence=${JSON.stringify({
        rotationStatus: rotationResponse.status,
        revokedIdMatches: rotationBody.revokedId === oldKey.id,
        replacementIdPresent: typeof replacementKeyId === 'string',
        oldKeyStatus: oldKeyState.rows[0]?.status,
        localReadWithoutReplacementGrant: readWithoutReplacementGrant.status,
        localReadWithReplacementGrant: readWithReplacementGrant.status,
        localWriteStatus: localWrite.status,
        adminEditStatus: edited.status,
        adminEditRevision: editedBody.revision,
        rollbackStatus: rolledBack.status,
        rollbackRevision: rollbackBody.revision,
        resolverMode: resolved.mode,
        resolverProfileId: resolved.mode === 'pinned' ? resolved.profileId : undefined,
        assignedReadAfterRollback: readAfterRollback.status,
      })}`);

      expect({
        rotationStatus: rotationResponse.status,
        revokedId: rotationBody.revokedId,
        oldKeyStatus: oldKeyState.rows[0]?.status,
        localReadWithoutReplacementGrant: readWithoutReplacementGrant.status,
        localReadWithReplacementGrant: readWithReplacementGrant.status,
        localReadKey: readWithReplacementGrant.body.apiKey && (readWithReplacementGrant.body.apiKey as { apiKeyId?: string }).apiKeyId,
        localWriteStatus: localWrite.status,
        localWriteCode: localWrite.body.code,
        adminEditStatus: edited.status,
        adminEditRevision: editedBody.revision,
        adminEditKey: editedBody.apiKey?.apiKeyId,
        rollbackStatus: rolledBack.status,
        rollbackRevision: rollbackBody.revision,
        rollbackKey: rollbackBody.apiKey?.apiKeyId,
        resolver: resolved.mode === 'pinned' ? resolved.profileId : resolved.mode,
        assignedReadAfterRollback: readAfterRollback.status,
      }).toEqual({
        rotationStatus: 201,
        revokedId: oldKey.id,
        oldKeyStatus: 'REVOKED',
        localReadWithoutReplacementGrant: 404,
        localReadWithReplacementGrant: 200,
        localReadKey: replacementKeyId,
        localWriteStatus: 403,
        localWriteCode: 'PROFILE_GROUP_ASSIGNMENT_REQUIRED',
        adminEditStatus: 200,
        adminEditRevision: 2,
        adminEditKey: replacementKeyId,
        rollbackStatus: 200,
        rollbackRevision: 3,
        rollbackKey: replacementKeyId,
        resolver: first.businesses[0]!.functions[0]!.childProfileId,
        assignedReadAfterRollback: 200,
      });
    }, 15_000);

    it('rejects a stale rotation snapshot, switches the new group to an existing key, then retries only the remaining memberships', async () => {
      await ensureBusinessEnabled();
      const secondDigest = await registerSecondVersion();
      const oldKey = await newKey('rotation-race-old');
      const existingKey = await newKey('rotation-race-existing');
      const firstGroup = await saveNewGroup(groupInput(
        tenantId,
        oldKey.id,
        businessId,
        manifestDigest,
        `rotation-race-v1-${randomUUID()}`,
      ));
      const firstChildId = firstGroup.businesses[0]!.functions[0]!.childProfileId;

      const groupBarrier = createBarrier(2, 30_000);
      const rotationSnapshots: Array<{ attempt: string; profileIds: string[]; versions: string[] }> = [];
      let rotationAttempt = 'interleaved';
      let groupBackend: { pid: number; xid: string } | undefined;
      let groupSavePromise: Promise<ProfileGroup> | undefined;
      let firstRotationPromise: ReturnType<typeof postAdminAction> | undefined;
      const originalListSelectors = app!.profiles.listActiveMembershipSelectors.bind(app!.profiles);
      app!.profiles.listActiveMembershipSelectors = async (apiKeyId, client) => {
        const memberships = await originalListSelectors(apiKeyId, client);
        if (apiKeyId === oldKey.id) {
          rotationSnapshots.push({
            attempt: rotationAttempt,
            profileIds: memberships.map((membership) => membership.profileId).sort(),
            versions: memberships.map((membership) => membership.selector.businessVersion).sort(),
          });
        }
        return memberships;
      };

      try {
        const pendingGroupSave = app!.db.tx((client) => saveProfileGroup(
          pauseAfterQuery(
            client,
            (sql) => /INSERT\s+INTO\s+profile_group_revisions/i.test(sql),
            groupBarrier,
            async (_sql, txClient) => {
              const identity = await txClient.query<{ pid: number; xid: string }>(
                'SELECT pg_backend_pid() AS pid, txid_current()::text AS xid',
              );
              groupBackend = identity.rows[0];
            },
          ),
          app!.profiles,
          app!.connectorManagement,
          groupInput(
            tenantId,
            oldKey.id,
            businessId,
            secondDigest,
            `rotation-race-v2-${randomUUID()}`,
            0,
            '2.0.0',
          ),
          null,
          tenantId,
        ));
        groupSavePromise = pendingGroupSave;
        await waitForSignal(groupBarrier.firstHit, 'second-group transaction barrier', 10_000);
        expect(groupBackend).toBeDefined();

        const failedReplacementRaw = `du_vfy_rotation_race_first_${randomUUID().replaceAll('-', '')}`;
        const pendingFirstRotation = postAdminAction('apikey.rotate', {
          apiKeyId: oldKey.id,
          apiKey: failedReplacementRaw,
        });
        firstRotationPromise = pendingFirstRotation;

        const deadline = Date.now() + 10_000;
        let blockedRotation: {
          pid: number;
          wait_event_type: string | null;
          wait_event: string | null;
          blocking_pids: number[];
          query: string;
        } | undefined;
        while (Date.now() < deadline && !blockedRotation) {
          const activity = await app!.db.query<{
            pid: number;
            wait_event_type: string | null;
            wait_event: string | null;
            blocking_pids: number[];
            query: string;
          }>(
            `SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids,
                    left(query, 220) AS query
               FROM pg_stat_activity
              WHERE datname=current_database() AND pid<>$1 AND state='active'
                AND position('FROM api_keys' in query)>0 AND position('FOR UPDATE' in query)>0
              ORDER BY query_start DESC`,
            [groupBackend!.pid],
          );
          blockedRotation = activity.rows.find((row) =>
            row.wait_event_type === 'Lock' && row.blocking_pids.includes(groupBackend!.pid),
          );
          if (!blockedRotation) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blockedRotation).toBeDefined();
        expect(blockedRotation!.wait_event_type).toBe('Lock');
        expect(blockedRotation!.blocking_pids).toContain(groupBackend!.pid);
        expect(rotationSnapshots.filter((snapshot) => snapshot.attempt === 'interleaved')).toEqual([{
          attempt: 'interleaved',
          profileIds: [firstChildId],
          versions: ['1.0.0'],
        }]);

        groupBarrier.release();
        const secondGroup = await pendingGroupSave;
        const secondChildId = secondGroup.businesses[0]!.functions[0]!.childProfileId;
        expect(secondChildId).not.toBe(firstChildId);
        const firstAttempt = await pendingFirstRotation;

        const failedReplacementHash = createHash('sha256').update(failedReplacementRaw).digest('hex');
        const failedReplacement = await app!.db.query<{ id: string }>(
          'SELECT id FROM api_keys WHERE hash=$1',
          [failedReplacementHash],
        );
        const failedReplacementInserted = (failedReplacement.rowCount ?? 0) > 0;
        const oldKeyAfterConflict = await app!.db.query<{ status: string }>(
          'SELECT status FROM api_keys WHERE id=$1',
          [oldKey.id],
        );
        const membershipAfterConflict = await app!.db.query<{
          api_key_id: string;
          state: string;
          count: string;
        }>(
          `SELECT api_key_id,state,count(*)::text AS count
             FROM profile_api_keys
            WHERE profile_id=ANY($1::uuid[])
            GROUP BY api_key_id,state ORDER BY api_key_id,state`,
          [[firstChildId, secondChildId]],
        );
        console.info(`[VFY-WOC] key rotation membership-race blocked-first-attempt=${JSON.stringify({
          groupBackend,
          rotationBackend: blockedRotation,
          snapshots: rotationSnapshots.filter((snapshot) => snapshot.attempt === 'interleaved'),
          secondGroupCommitted: secondGroup.revision === 1,
          firstRotationStatus: firstAttempt.status,
          firstRotationCode: firstAttempt.body.code,
          failedReplacementInserted,
          oldKeyStatusAfterConflict: oldKeyAfterConflict.rows[0]?.status,
          membershipsAfterConflict: membershipAfterConflict.rows,
        })}`);
        expect({
          firstRotationStatus: firstAttempt.status,
          firstRotationCode: firstAttempt.body.code,
          failedReplacementInserted,
          oldKeyStatus: oldKeyAfterConflict.rows[0]?.status,
          firstAttemptSnapshots: rotationSnapshots.filter((snapshot) => snapshot.attempt === 'interleaved'),
          membershipsAfterConflict: membershipAfterConflict.rows,
        }).toEqual({
          firstRotationStatus: 409,
          firstRotationCode: 'STATE_CONFLICT',
          failedReplacementInserted: false,
          oldKeyStatus: 'ACTIVE',
          firstAttemptSnapshots: [
            { attempt: 'interleaved', profileIds: [firstChildId], versions: ['1.0.0'] },
            { attempt: 'interleaved', profileIds: [firstChildId, secondChildId].sort(), versions: ['1.0.0', '2.0.0'] },
          ],
          membershipsAfterConflict: [{ api_key_id: oldKey.id, state: 'ACTIVE', count: '2' }],
        });

        const groupKeySwitch = await fetch(`${internalBaseUrl}/api/v1/admin/profile-groups/${secondGroup.groupId}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(groupInput(
            tenantId,
            existingKey.id,
            businessId,
            secondDigest,
            secondGroup.name,
            1,
            '2.0.0',
          )),
        });
        const switchedGroup = await groupKeySwitch.json() as {
          revision?: number;
          apiKey?: { apiKeyId?: string };
        };
        expect({
          status: groupKeySwitch.status,
          revision: switchedGroup.revision,
          apiKeyId: switchedGroup.apiKey?.apiKeyId,
        }).toEqual({ status: 200, revision: 2, apiKeyId: existingKey.id });

        const firstOnlyMemberships = await app!.db.query<{ profile_id: string; api_key_id: string; state: string }>(
          `SELECT profile_id,api_key_id,state FROM profile_api_keys
            WHERE profile_id=ANY($1::uuid[]) ORDER BY profile_id,api_key_id`,
          [[firstChildId, secondChildId]],
        );
        expect(firstOnlyMemberships.rows).toEqual([
          { profile_id: firstChildId, api_key_id: oldKey.id, state: 'ACTIVE' },
          { profile_id: secondChildId, api_key_id: oldKey.id, state: 'REVOKED' },
          { profile_id: secondChildId, api_key_id: existingKey.id, state: 'ACTIVE' },
        ].sort((left, right) => `${left.profile_id}:${left.api_key_id}`.localeCompare(`${right.profile_id}:${right.api_key_id}`)));

        rotationAttempt = 'retry';
        const replacementRaw = `du_vfy_rotation_race_retry_${randomUUID().replaceAll('-', '')}`;
        const retry = await postAdminAction('apikey.rotate', {
          apiKeyId: oldKey.id,
          apiKey: replacementRaw,
        });
        const retryBody = retry.body as { apiKeyId?: string; revokedId?: string; status?: string };
        expect(retry.status).toBe(201);
        expect(retryBody).toMatchObject({ revokedId: oldKey.id, status: 'ACTIVE' });
        const replacementKeyId = retryBody.apiKeyId;
        expect(typeof replacementKeyId).toBe('string');

        const allMemberships = await app!.db.query<{ profile_id: string; api_key_id: string; state: string }>(
          `SELECT profile_id,api_key_id,state FROM profile_api_keys
            WHERE profile_id=ANY($1::uuid[]) ORDER BY profile_id,api_key_id`,
          [[firstChildId, secondChildId]],
        );
        const groupGetResponse = await fetch(`${internalBaseUrl}/api/v1/admin/profile-groups/${secondGroup.groupId}`, {
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const groupGet = await groupGetResponse.json() as {
          groupId?: string;
          revision?: number;
          apiKey?: { apiKeyId?: string; status?: string };
        };
        const rollbackResponse = await fetch(`${internalBaseUrl}/api/v1/admin/profile-groups/${secondGroup.groupId}/rollback`, {
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ targetRevision: 1, expectedRevision: 2 }),
        });
        const rollbackBody = await rollbackResponse.json() as {
          revision?: number;
          apiKey?: { apiKeyId?: string; status?: string };
        };
        const groupGetAfterRollbackResponse = await fetch(`${internalBaseUrl}/api/v1/admin/profile-groups/${secondGroup.groupId}`, {
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const groupGetAfterRollback = await groupGetAfterRollbackResponse.json() as {
          revision?: number;
          apiKey?: { apiKeyId?: string; status?: string };
        };
        const resolvedSecondVersion = await app!.profiles.resolveEffectiveProfile(
          existingKey.id, businessId, '2.0.0', 'extract',
        );
        const retrySnapshots = rotationSnapshots.filter((snapshot) => snapshot.attempt === 'retry');
        console.info(`[VFY-WOC] key rotation membership-race key-switch-and-retry=${JSON.stringify({
          retryStatus: retry.status,
          retrySnapshotProfiles: retrySnapshots.map((snapshot) => snapshot.profileIds),
          existingKeyIsGroupEffectiveKey: groupGet.apiKey?.apiKeyId === existingKey.id,
          replacementInheritedSecondChild: allMemberships.rows.some((row) => row.api_key_id === replacementKeyId && row.profile_id === secondChildId && row.state === 'ACTIVE'),
          memberships: allMemberships.rows,
          groupGetStatus: groupGetResponse.status,
          groupGetKeyId: groupGet.apiKey?.apiKeyId,
          rollbackStatus: rollbackResponse.status,
          rollbackRevision: rollbackBody.revision,
          rollbackKeyId: rollbackBody.apiKey?.apiKeyId,
          groupGetAfterRollbackStatus: groupGetAfterRollbackResponse.status,
          groupGetAfterRollbackKeyId: groupGetAfterRollback.apiKey?.apiKeyId,
          resolvedMode: resolvedSecondVersion.mode,
          resolvedProfileId: resolvedSecondVersion.mode === 'pinned' ? resolvedSecondVersion.profileId : undefined,
        })}`);
        expect({
          retrySnapshots,
          memberships: allMemberships.rows,
          groupGetStatus: groupGetResponse.status,
          groupGetId: groupGet.groupId,
          groupGetRevision: groupGet.revision,
          groupGetKeyId: groupGet.apiKey?.apiKeyId,
          groupGetKeyStatus: groupGet.apiKey?.status,
          rollbackStatus: rollbackResponse.status,
          rollbackRevision: rollbackBody.revision,
          rollbackKeyId: rollbackBody.apiKey?.apiKeyId,
          groupGetAfterRollbackStatus: groupGetAfterRollbackResponse.status,
          groupGetAfterRollbackRevision: groupGetAfterRollback.revision,
          groupGetAfterRollbackKeyId: groupGetAfterRollback.apiKey?.apiKeyId,
          resolvedMode: resolvedSecondVersion.mode,
          resolvedProfileId: resolvedSecondVersion.mode === 'pinned' ? resolvedSecondVersion.profileId : undefined,
        }).toEqual({
          retrySnapshots: [
            { attempt: 'retry', profileIds: [firstChildId], versions: ['1.0.0'] },
            { attempt: 'retry', profileIds: [firstChildId], versions: ['1.0.0'] },
          ],
          memberships: [
            { profile_id: firstChildId, api_key_id: oldKey.id, state: 'REVOKED' },
            { profile_id: firstChildId, api_key_id: replacementKeyId, state: 'ACTIVE' },
            { profile_id: secondChildId, api_key_id: oldKey.id, state: 'REVOKED' },
            { profile_id: secondChildId, api_key_id: existingKey.id, state: 'ACTIVE' },
          ].sort((left, right) => `${left.profile_id}:${left.api_key_id}`.localeCompare(`${right.profile_id}:${right.api_key_id}`)),
          groupGetStatus: 200,
          groupGetId: secondGroup.groupId,
          groupGetRevision: 2,
          groupGetKeyId: existingKey.id,
          groupGetKeyStatus: 'ACTIVE',
          rollbackStatus: 200,
          rollbackRevision: 3,
          rollbackKeyId: existingKey.id,
          groupGetAfterRollbackStatus: 200,
          groupGetAfterRollbackRevision: 3,
          groupGetAfterRollbackKeyId: existingKey.id,
          resolvedMode: 'pinned',
          resolvedProfileId: secondChildId,
        });
      } finally {
        groupBarrier.release();
        await groupSavePromise?.catch(() => undefined);
        await firstRotationPromise?.catch(() => undefined);
        app!.profiles.listActiveMembershipSelectors = originalListSelectors;
      }
    }, 60_000);
  });
});
