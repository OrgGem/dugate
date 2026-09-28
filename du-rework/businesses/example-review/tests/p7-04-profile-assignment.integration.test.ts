import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createDb, type App } from '@du/orchestrator';
import { contentHash } from '@du/contracts';
import { exampleReviewManifest } from '../src/manifest';
import {
  registerExtensionWorker,
  freezePlatformDigests,
} from '../src/registry-tool';
import {
  buildProfileFormField,
  buildProfileFormModel,
  checkProfileRevision,
  diffProfileRevision,
  mapSchemaToWidget,
  validateProfileDraft,
  type ProfileDraft,
  type ProfileSchemaInput,
} from '../../../services/orchestrator/src/app/admin/profile-view-models';
import {
  evaluateAuthGuard,
  getCanonicalNavItems,
} from '../../../services/orchestrator/src/app/admin/p6-01-shell-fixtures';
import { signCookie } from '../../../services/orchestrator/src/app/admin/shell-auth';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../../../tests/isolation/namespace';
import { assertTestDatabase, assertTestRedis } from './helpers/test-target-guard';

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
      });

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx
  ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL)
  : BASE_DATABASE_URL;

const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const REDIS_URL = process.env.REDIS_URL ?? (
  isolationCtx && process.env.REDIS_DB_INDEX
    ? `redis://127.0.0.1:6380/${process.env.REDIS_DB_INDEX}`
    : BASE_REDIS_URL
);

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

describe('P7-04: Generic Admin Profile Assignment & Generic API Submission (UI-01 / PRF-01..02)', () => {
  let app: App | undefined;
  let orchestratorUrl: string;
  let assignedProfileId: string;
  let firstOperationId: string;

  const adminToken = `adm-${randomUUID()}`;
  const runtimeToken = `rt-${randomUUID()}`;
  const usageToken = `usg-${randomUUID()}`;
  const grantSecret = `grant-${randomUUID()}`;
  const shellCookieSecret = 'test-shell-cookie-secret-min-32-chars-long-xyz-987';

  const tenantA = '00000000-0000-0000-0000-000000000001';
  const apiKeyA = `du_test_${randomUUID().replace(/-/g, '')}`;
  const keyAId = randomUUID();

  const tenantB = '00000000-0000-0000-0000-000000000002';
  const apiKeyRestricted = `du_test_${randomUUID().replace(/-/g, '')}`;
  const restrictedKeyId = randomUUID();

  const apiKeyLegacy = `du_test_${randomUUID().replace(/-/g, '')}`;
  const legacyKeyId = randomUUID();

  beforeAll(async () => {
    assertTestDatabase(BASE_DATABASE_URL);
    assertTestRedis(BASE_REDIS_URL);

    if (isolationCtx) {
      const adminDb = createDb(BASE_DATABASE_URL);
      await adminDb.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await adminDb.close();
    }

    app = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      adminToken,
      runtimeToken,
      usageToken,
      invocationGrantSecret: grantSecret,
      connectorId: 'test-connector',
      connectorRevision: 1,
      adminShellCookieSecret: shellCookieSecret,
      adminShellPort: 0,
      autoDispatch: false,
      autoMigrate: true,
    });

    await app.listen();
    const addr = app.server.address() as AddressInfo;
    orchestratorUrl = `http://127.0.0.1:${addr.port}`;

    // Seed Tenant A and primary test key
    await app.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-a', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [tenantA]
    );
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'test-a', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [keyAId, tenantA, hashKey(apiKeyA)]
    );

    // Seed Tenant B with restricted profile bindings (other business only)
    await app.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-b', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [tenantB]
    );
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'test-b', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [restrictedKeyId, tenantB, hashKey(apiKeyRestricted)]
    );
    await app.db.query(
      `INSERT INTO profile_bindings (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action, connector_bindings)
       VALUES ($1, 1, $2, $3, 'other-biz', '1.0.0', 'other-action', '{}')`,
      [randomUUID(), tenantB, restrictedKeyId]
    );

    // Seed legacy API key with ZERO profile bindings
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'test-legacy', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [legacyKeyId, tenantA, hashKey(apiKeyLegacy)]
    );

    // Register, enable, and activate example-review business
    await registerExtensionWorker({
      orchestratorUrl,
      runtimeToken,
      adminToken,
      manifest: exampleReviewManifest,
      activate: true,
    });
  }, 30_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (isolationCtx) {
      const adminDb = createDb(BASE_DATABASE_URL);
      await adminDb.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await adminDb.close();
    }
  }, 15_000);

  // ---------------------------------------------------------------------------
  // 1. UI-01: Generic Dynamic Schema Profile Editor View Models (Zero Code Branching)
  // ---------------------------------------------------------------------------
  describe('1. UI-01: Generic Dynamic Schema Profile Editor View Models', () => {
    test('builds dynamic profile form model from business manifest without business-specific code branching', () => {
      const schemaInput: ProfileSchemaInput = {
        businessId: exampleReviewManifest.businessId,
        businessVersion: exampleReviewManifest.version,
        manifest: {
          actions: exampleReviewManifest.actions.map((act) => ({
            name: act.name,
            title: act.displayName,
            slots: act.connectorSlots?.map((slot) => ({
              name: slot.name,
              required: slot.required,
              description: `Connector slot for ${slot.name}`,
              widget: 'select',
              options: slot.acceptedCapabilities.map((cap) => ({
                value: `test-connector:${cap}`,
                label: `Test Connector (${cap})`,
              })),
            })),
          })),
        },
        capabilityOptions: [
          { connectorId: 'test-connector', capability: 'chat-completion', label: 'Chat Completion' },
          { connectorId: 'test-connector', capability: 'structured-output', label: 'Structured Output' },
        ],
        existingProfile: { name: 'default-profile', revision: 0 },
      };

      const formModel = buildProfileFormModel(schemaInput);

      expect(formModel.businessId).toBe('example-review');
      expect(formModel.businessVersion).toBe('1.0.0');
      expect(formModel.profileName).toBe('default-profile');
      expect(formModel.revisionLabel).toBe('rev 0');

      // Sections match manifest actions
      expect(formModel.sections.length).toBe(1);
      const reviewSection = formModel.sections[0]!;
      expect(reviewSection.actionName).toBe('review');

      // Fields match connectorSlots dynamically
      expect(reviewSection.fields.length).toBe(1);
      const reasoningField = reviewSection.fields[0]!;
      expect(reasoningField.slotName).toBe('reasoning');
      expect(reasoningField.widget).toBe('select');
      expect(reasoningField.required).toBe(false);
      expect(reasoningField.options).toBeDefined();
      expect(reasoningField.options?.length).toBe(2);
      expect(reasoningField.options?.[0]).toEqual({
        value: 'test-connector:chat-completion',
        label: 'Test Connector (chat-completion)',
      });
      expect(reasoningField.options?.[1]).toEqual({
        value: 'test-connector:structured-output',
        label: 'Test Connector (structured-output)',
      });
      expect(reasoningField.unknownFallback).toBeUndefined();
    });

    test('safely falls back to text widget for unknown widget types with non-blocking indication', () => {
      const unknownSlot = {
        name: 'experimental-embedder',
        widget: 'unknown-vector-tensor-widget-v3',
        description: 'Future widget not yet in KNOWN_WIDGETS',
      };

      const field = buildProfileFormField(unknownSlot, []);
      expect(field.widget).toBe('text');
      expect(field.unknownFallback).toBe(true);

      const mapping = mapSchemaToWidget('unknown-vector-tensor-widget-v3');
      expect(mapping.widget).toBe('text');
      expect(mapping.unknown).toBe(true);
      expect(mapping.fallbackReason).toContain('unknown-vector-tensor-widget-v3');
    });

    test('validates profile draft against manifest slice and staleness checks', () => {
      const actions = [
        {
          actionName: 'review',
          slots: [
            {
              name: 'reasoning',
              required: false,
              widget: 'select',
              options: [
                { value: 'test-connector:1', label: 'Test Connector v1' },
                { value: 'test-connector:2', label: 'Test Connector v2' },
              ],
            },
          ],
        },
      ];

      const validDraft: ProfileDraft = {
        businessId: 'example-review',
        businessVersion: '1.0.0',
        profileName: 'review-profile-live',
        formRevision: 0,
        entries: [{ slotName: 'reasoning', value: 'test-connector:1' }],
      };

      const validResult = validateProfileDraft({
        draft: validDraft,
        actions,
        capabilityOptions: [{ connectorId: 'test-connector', capability: 'chat-completion' }],
        serverProfile: null,
      });
      expect(validResult.ok).toBe(true);
      expect(validResult.issues).toHaveLength(0);

      // Stale revision detection
      const staleResult = validateProfileDraft({
        draft: { ...validDraft, formRevision: 1 },
        actions,
        capabilityOptions: [],
        serverProfile: { revision: 3 },
      });
      expect(staleResult.ok).toBe(false);
      expect(staleResult.issues).toContainEqual({
        code: 'stale-revision',
        slotName: '',
        message: 'Draft is at revision 1 but server is at revision 3',
      });
    });

    test('diffs profile revision with strict secret protection and change classification', () => {
      const oldRevision = {
        reasoning: 'test-connector:1',
        'api-token': 'secret-token-old',
        'idle-timeout': '30',
      };

      const newRevision = {
        reasoning: 'test-connector:2',
        'api-token': 'secret-token-new',
        'idle-timeout': '30',
      };

      const diff = diffProfileRevision(oldRevision, newRevision, {
        secretSlots: ['api-token'],
      });
      expect(diff.identical).toBe(false);

      const reasoningDiff = diff.entries.find((e) => e.slotName === 'reasoning');
      expect(reasoningDiff).toEqual({
        kind: 'changed',
        slotName: 'reasoning',
        from: 'test-connector:1',
        to: 'test-connector:2',
      });

      // Secrets must never be echoed raw
      const secretDiff = diff.entries.find((e) => e.slotName === 'api-token');
      expect(secretDiff).toEqual({
        kind: 'changed-secret',
        slotName: 'api-token',
      });

      const unchangedDiff = diff.entries.find((e) => e.slotName === 'idle-timeout');
      expect(unchangedDiff).toEqual({
        kind: 'unchanged',
        slotName: 'idle-timeout',
      });
    });

    test('evaluates auth guard for Profiles section: denies viewer, allows operator and admin', () => {
      const navItems = getCanonicalNavItems();
      const profilesNav = navItems.find((n) => n.section === 'profiles');
      expect(profilesNav).toBeDefined();
      expect(profilesNav?.requiredRole).toBe('operator');

      const viewerDecision = evaluateAuthGuard('viewer', 'profiles', navItems);
      expect(viewerDecision.kind).toBe('denied');
      if (viewerDecision.kind === 'denied') {
        expect(viewerDecision.requiredRole).toBe('operator');
        expect(viewerDecision.actualRole).toBe('viewer');
      }

      const operatorDecision = evaluateAuthGuard('operator', 'profiles', navItems);
      expect(operatorDecision.kind).toBe('allowed');

      const adminDecision = evaluateAuthGuard('admin', 'profiles', navItems);
      expect(adminDecision.kind).toBe('allowed');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Generic Admin Shell Live Server Mounting & Auth Enforcement
  // ---------------------------------------------------------------------------
  describe('2. Generic Admin Shell Live Mounting & Profile Page Access', () => {
    test('orchestrator boots with standalone Admin Shell listener attached', () => {
      expect(app!.adminShell).toBeDefined();
      expect(app!.adminShell?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    test('GET /admin/profiles without cookie returns 401 sign-in required', async () => {
      const shellUrl = app!.adminShell!.url;
      const resp = await fetch(`${shellUrl}/admin/profiles`);
      expect(resp.status).toBe(401);
      const text = await resp.text();
      expect(text).toContain('Sign-in required');
    });

    test('GET /admin/profiles with viewer cookie returns 403 access denied (requires operator)', async () => {
      const shellUrl = app!.adminShell!.url;
      const viewerCookie = signCookie(shellCookieSecret, {
        iss: 'du-admin-shell',
        role: 'viewer',
        iat: Date.now(),
        exp: Date.now() + 3600_000,
      });

      const resp = await fetch(`${shellUrl}/admin/profiles`, {
        headers: {
          cookie: `du_admin=${viewerCookie}`,
        },
      });

      expect(resp.status).toBe(403);
      const text = await resp.text();
      expect(text).toContain('Access denied');
      expect(text).toContain('is not authorized for this section');
      expect(text).toContain('operator');
    });

    test('GET /admin/profiles with operator signed cookie returns 200 HTML with Profiles navigation', async () => {
      const shellUrl = app!.adminShell!.url;
      const operatorCookie = signCookie(shellCookieSecret, {
        iss: 'du-admin-shell',
        role: 'operator',
        iat: Date.now(),
        exp: Date.now() + 3600_000,
      });

      const resp = await fetch(`${shellUrl}/admin/profiles`, {
        headers: {
          cookie: `du_admin=${operatorCookie}`,
        },
      });

      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toContain('text/html');
      const text = await resp.text();
      expect(text).toContain('Profiles');
      expect(text).toContain('data-admin-shell="v1"');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Generic Admin API Profile Binding (POST /api/v1/admin/profile-bindings)
  // ---------------------------------------------------------------------------
  describe('3. Generic Admin API Profile Binding Execution', () => {
    test('POST /api/v1/admin/profile-bindings without admin bearer token returns 401 UNAUTHENTICATED', async () => {
      const resp = await fetch(`${orchestratorUrl}/api/v1/admin/profile-bindings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKeyA,
          businessId: 'example-review',
          businessVersion: '1.0.0',
          action: 'review',
          connectorBindings: { reasoning: { connectorId: 'test-connector', revision: 1 } },
        }),
      });

      expect(resp.status).toBe(401);
      const body = (await resp.json()) as { code: string };
      expect(body.code).toBe('UNAUTHENTICATED');
    });

    test('POST /api/v1/admin/profile-bindings with invalid schema returns 422 INVALID_SCHEMA', async () => {
      const resp = await fetch(`${orchestratorUrl}/api/v1/admin/profile-bindings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          // missing apiKey
          businessId: 'example-review',
          businessVersion: '1.0.0',
          action: 'review',
        }),
      });

      expect(resp.status).toBe(422);
      const body = (await resp.json()) as { code: string };
      expect(body.code).toBe('INVALID_SCHEMA');
    });

    test('POST /api/v1/admin/profile-bindings assigns initial profile revision 1 to apiKeyA', async () => {
      const resp = await fetch(`${orchestratorUrl}/api/v1/admin/profile-bindings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          apiKey: apiKeyA,
          businessId: 'example-review',
          businessVersion: '1.0.0',
          action: 'review',
          connectorBindings: {
            reasoning: {
              connectorId: 'test-connector',
              revision: 1,
            },
          },
        }),
      });

      expect(resp.status).toBe(201);
      const body = (await resp.json()) as { profileId: string; revision: number };
      expect(body.profileId).toBeDefined();
      expect(body.revision).toBe(1);
      assignedProfileId = body.profileId;

      // Verify row persisted in database profile_bindings
      const dbRow = await app!.db.query<{
        profile_id: string;
        revision: number;
        business_id: string;
        business_version: string;
        action: string;
        connector_bindings: Record<string, unknown>;
      }>(
        `SELECT profile_id, revision, business_id, business_version, action, connector_bindings
         FROM profile_bindings WHERE profile_id = $1`,
        [assignedProfileId]
      );

      expect(dbRow.rowCount).toBe(1);
      expect(dbRow.rows[0]!.revision).toBe(1);
      expect(dbRow.rows[0]!.business_id).toBe('example-review');
      expect(dbRow.rows[0]!.business_version).toBe('1.0.0');
      expect(dbRow.rows[0]!.action).toBe('review');
      expect(dbRow.rows[0]!.connector_bindings).toEqual({
        reasoning: {
          connectorId: 'test-connector',
          revision: 1,
        },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Generic Public API Submission with Profile Pinning
  // ---------------------------------------------------------------------------
  describe('4. Generic Public API Submission with Profile Pinning', () => {
    test('public submission with profile-bound apiKeyA creates operation pinned to profile revision 1', async () => {
      const resp = await fetch(`${orchestratorUrl}/api/v1/businesses/example-review/actions/review`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKeyA,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            reviewId: 'rev-p704-live-1',
            artifacts: [
              {
                artifactId: 'art-sample-doc-1',
                fileName: 'sample-contract.pdf',
              },
            ],
            enableReasoning: true,
            requireApproval: false,
          },
        }),
      });

      expect(resp.status).toBe(202);
      const body = (await resp.json()) as {
        operationId: string;
        state: string;
        stateVersion: number;
      };
      expect(body.operationId).toBeDefined();
      expect(body.state).toBe('ACCEPTED');
      firstOperationId = body.operationId;

      // Verify execution pin on operation record in database
      const opRow = await app!.db.query<{
        id: string;
        business_id: string;
        business_version: string;
        action: string;
        profile_id: string;
        profile_revision: number;
        connector_bindings: Record<string, unknown>;
      }>(
        `SELECT id, business_id, business_version, action, profile_id, profile_revision, connector_bindings
         FROM operations WHERE id = $1`,
        [firstOperationId]
      );

      expect(opRow.rowCount).toBe(1);
      const op = opRow.rows[0]!;
      expect(op.business_id).toBe('example-review');
      expect(op.business_version).toBe('1.0.0');
      expect(op.action).toBe('review');
      expect(op.profile_id).toBe(assignedProfileId);
      expect(op.profile_revision).toBe(1);
      expect(op.connector_bindings).toEqual({
        reasoning: 'test-connector@1',
      });
    });

    test('GET /api/v1/operations/:id returns operation view confirming state and action', async () => {
      const resp = await fetch(`${orchestratorUrl}/api/v1/operations/${firstOperationId}`, {
        headers: {
          'x-api-key': apiKeyA,
        },
      });

      expect(resp.status).toBe(200);
      const op = (await resp.json()) as {
        id: string;
        businessId: string;
        businessVersion: string;
        action: string;
        state: string;
      };
      expect(op.id).toBe(firstOperationId);
      expect(op.businessId).toBe('example-review');
      expect(op.businessVersion).toBe('1.0.0');
      expect(op.action).toBe('review');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Negative Authorization Boundaries (PRF-01) & Legacy Fallback
  // ---------------------------------------------------------------------------
  describe('5. Negative Authorization Boundaries (PRF-01) & Legacy Fallback', () => {
    test('PRF-01: key in profile mode without action binding is rejected with 403 FORBIDDEN', async () => {
      // apiKeyRestricted has a profile binding for 'other-biz', none for 'example-review'
      const resp = await fetch(`${orchestratorUrl}/api/v1/businesses/example-review/actions/review`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKeyRestricted,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            reviewId: 'rev-forbidden-p704',
            artifacts: [{ artifactId: 'art-1', fileName: 'doc.pdf' }],
          },
        }),
      });

      expect(resp.status).toBe(403);
      const err = (await resp.json()) as { code: string; detail?: string; title?: string };
      expect(err.code).toBe('PERMISSION_DENIED');
      expect(err.title).toContain('not authorized for action review');

      // Verify no operation row or task row was inserted
      const opCount = await app!.db.query<{ count: string }>(
        `SELECT count(*) FROM operations WHERE api_key_id = $1`,
        [restrictedKeyId]
      );
      expect(Number(opCount.rows[0]!.count)).toBe(0);
    });

    test('legacy key with zero profile bindings operates in legacy fallback mode (profile_id null)', async () => {
      const resp = await fetch(`${orchestratorUrl}/api/v1/businesses/example-review/actions/review`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKeyLegacy,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            reviewId: 'rev-legacy-p704',
            artifacts: [{ artifactId: 'art-legacy-1', fileName: 'doc.pdf' }],
          },
        }),
      });

      expect(resp.status).toBe(202);
      const body = (await resp.json()) as { operationId: string };

      const opRow = await app!.db.query<{ profile_id: string | null; profile_revision: number | null }>(
        `SELECT profile_id, profile_revision FROM operations WHERE id = $1`,
        [body.operationId]
      );
      expect(opRow.rowCount).toBe(1);
      expect(opRow.rows[0]!.profile_id).toBeNull();
      expect(opRow.rows[0]!.profile_revision).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Immutable Profile Revision Evolution & Execution Pin Stability (PRF-02)
  // ---------------------------------------------------------------------------
  describe('6. Immutable Profile Revision Evolution & Execution Pin Stability (PRF-02)', () => {
    let secondOperationId: string;

    test('assigns profile revision 2 updating connector revision to 2', async () => {
      const resp = await fetch(`${orchestratorUrl}/api/v1/admin/profile-bindings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          profileId: assignedProfileId,
          apiKey: apiKeyA,
          businessId: 'example-review',
          businessVersion: '1.0.0',
          action: 'review',
          connectorBindings: {
            reasoning: {
              connectorId: 'test-connector',
              revision: 2,
            },
          },
        }),
      });

      expect(resp.status).toBe(201);
      const body = (await resp.json()) as { profileId: string; revision: number };
      expect(body.profileId).toBe(assignedProfileId);
      expect(body.revision).toBe(2);

      // Verify 2 revision rows exist for this profile
      const revRows = await app!.db.query<{ revision: number }>(
        `SELECT revision FROM profile_bindings WHERE profile_id = $1 ORDER BY revision ASC`,
        [assignedProfileId]
      );
      expect(revRows.rowCount).toBe(2);
      expect(revRows.rows.map((r) => r.revision)).toEqual([1, 2]);
    });

    test('new submission with apiKeyA pins to revision 2', async () => {
      const resp = await fetch(`${orchestratorUrl}/api/v1/businesses/example-review/actions/review`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKeyA,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            reviewId: 'rev-p704-live-2',
            artifacts: [
              {
                artifactId: 'art-sample-doc-2',
                fileName: 'sample-contract-v2.pdf',
              },
            ],
            enableReasoning: true,
          },
        }),
      });

      expect(resp.status).toBe(202);
      const body = (await resp.json()) as { operationId: string };
      secondOperationId = body.operationId;

      const opRow = await app!.db.query<{
        profile_id: string;
        profile_revision: number;
        connector_bindings: Record<string, unknown>;
      }>(
        `SELECT profile_id, profile_revision, connector_bindings FROM operations WHERE id = $1`,
        [secondOperationId]
      );
      expect(opRow.rowCount).toBe(1);
      expect(opRow.rows[0]!.profile_id).toBe(assignedProfileId);
      expect(opRow.rows[0]!.profile_revision).toBe(2);
      expect(opRow.rows[0]!.connector_bindings).toEqual({
        reasoning: 'test-connector@2',
      });
    });

    test('previously submitted in-flight operation retains immutable revision 1 pin (PRF-02 guarantee)', async () => {
      const op1Row = await app!.db.query<{
        profile_id: string;
        profile_revision: number;
        connector_bindings: Record<string, unknown>;
      }>(
        `SELECT profile_id, profile_revision, connector_bindings FROM operations WHERE id = $1`,
        [firstOperationId]
      );

      expect(op1Row.rowCount).toBe(1);
      const op1 = op1Row.rows[0]!;
      // Proves first operation's pin did NOT drift to revision 2
      expect(op1.profile_id).toBe(assignedProfileId);
      expect(op1.profile_revision).toBe(1);
      expect(op1.connector_bindings).toEqual({
        reasoning: 'test-connector@1',
      });
    });
  });
});
