import { decodeLegacyWorkflowJson, decodeLegacyWorkflowXml, LegacyWorkflowDecodeError } from '../src/compat/legacy-workflow-decoders';
import { createProfileSelfServiceService, type ProfileSelfServiceActor } from '../src/modules/profiles/self-service';
import { createSubmissionService } from '../src/modules/operations/submission';
import { assertAdminWorkbenchAdmissionScope, submitProfileEndpointTest, trustedLocalAdminWorkbenchActor } from '../src/modules/admin-workbench/service';
import { matchProfilesRoute } from '../src/app/admin/bff/profiles';
import { canonicalLegacyWorkflowPinBytes } from '../../../packages/contracts/src/legacy-workflow';
import { canonicalRequestHash } from '@du/contracts';
import { connectorNodeAtPath, updateConnectorNodeOverride } from '../../../apps/admin-web/src/features/workflows/revision-editor';

const tenantId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

describe('ORV14 workflow import and assigned Profile workbench', () => {
  test('legacy XML converts full supported node and override fields into the validated schema', () => {
    const schema = decodeLegacyWorkflowXml(`<?xml version="1.0"?>
      <workflow slug="invoice-flow" name="Invoice &amp; receipt" version="3" description="A &lt;safe&gt; flow">
        <input><property name="document" type="string" required="true" label="Document" /></input>
        <nodes>
          <node id="source" type="input" key="document" />
          <node id="extract" type="connector" connector="ocr" promptOverrideKey="invoice" outputPath="response.data">
            <input key="document" value="$source" />
            <overrideConnector prompt="Read {{document}}" staticFormFields="[{&quot;name&quot;:&quot;mode&quot;,&quot;value&quot;:&quot;invoice&quot;}]" extraHeaders="[]" timeoutSec="30" />
          </node>
          <node id="review" type="human" message="Review evidence" resumeInputs="approved,notes" />
        </nodes>
        <flow><step id="source" /><step id="extract" /><step id="review" /></flow>
        <output from="extract" />
      </workflow>`);
    expect(schema.slug).toBe('invoice-flow');
    expect(schema.name).toBe('Invoice & receipt');
    expect(schema.nodes[1]).toMatchObject({
      id: 'extract', type: 'connector', connector: 'ocr', promptOverrideKey: 'invoice',
      inputs: { document: '$source' },
      overrideConnector: { prompt: 'Read {{document}}', staticFormFields: '[{"name":"mode","value":"invoice"}]', extraHeaders: '[]', timeoutSec: 30 },
    });
    expect(schema.nodes[2]).toMatchObject({ type: 'human', resumeInputs: ['approved', 'notes'] });
  });

  test('XML parser rejects DTD/entity expansion, unknown elements, and oversized input before mapping', () => {
    const prefix = '<workflow slug="safe"><nodes><node id="start" type="input" key="x"/></nodes><flow><step id="start"/></flow></workflow>';
    expect(() => decodeLegacyWorkflowXml(`<!DOCTYPE workflow [<!ENTITY x SYSTEM "file:///etc/passwd">]>${prefix}`)).toThrow(LegacyWorkflowDecodeError);
    expect(() => decodeLegacyWorkflowXml(prefix.replace('key="x"', 'key="&custom;"'))).toThrow(/entity reference/);
    expect(() => decodeLegacyWorkflowXml(prefix.replace('</nodes>', '<unsupported/></nodes>'))).toThrow(/unsupported|only/);
    expect(() => decodeLegacyWorkflowXml(` ${' '.repeat(512 * 1024)}${prefix}`)).toThrow(/512 KiB/);
  });

  test('JSON and XML binding checks reject cycles, dangling nodes, and cross-branch references', () => {
    const schema = (inputs: unknown) => JSON.stringify({
      slug: 'bound-flow', name: 'Bound flow',
      nodes: [
        { id: 'parallel', type: 'parallel', branches: [[{ id: 'left', type: 'connector', connector: 'a', inputs }], [{ id: 'right', type: 'connector', connector: 'b' }]] },
        { id: 'end', type: 'join' },
      ],
      flow: ['parallel', 'end'],
    });
    expect(() => decodeLegacyWorkflowJson(schema({ value: '$left.result' }))).toThrow(/future, cyclic, or foreign-branch/);
    expect(() => decodeLegacyWorkflowJson(JSON.stringify({ slug: 'cycle', name: 'Cycle', nodes: [{ id: 'same', type: 'connector', connector: 'a', inputs: { value: '$same.result' } }], flow: ['same'] }))).toThrow(/future, cyclic/);
    expect(() => decodeLegacyWorkflowJson(JSON.stringify({ slug: 'missing', name: 'Missing', nodes: [{ id: 'one', type: 'connector', connector: 'a', inputs: { value: '$missing.result' } }], flow: ['one'] }))).toThrow(/missing workflow node/);
  });

  test('assigned Profile list returns only assignment-scoped safe inputs and never parameter credentials', async () => {
    const row = {
      profile_id: profileId, tenant_id: tenantId, business_id: 'document-core', business_version: '1.2.3',
      profile_name: 'extract.invoice', action: 'extract', endpoint_slug: 'extract:invoice', revision: 4,
      connector_bindings: { reasoning: { connectorId: 'ext-prompt-wizard', revision: 2 } },
      parameters: { document_name: { value: 'invoice.pdf' }, api_token: { value: 'do-not-return' } },
      connections_override: [{ slug: 'ocr', stepId: 'extract:connector-inference', captureSession: 'session-a' }],
    };
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT version FROM admin_local_users')) return { rowCount: 1, rows: [{ version: 7 }] };
        if (sql.includes('count(DISTINCT')) return { rowCount: 1, rows: [{ total: 1 }] };
        if (sql.includes('SELECT p.profile_id,p.tenant_id')) return { rowCount: 1, rows: [row] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const manifest = { actions: [{ name: 'extract', inputSchema: { type: 'object', properties: {
      documentName: { type: 'string' }, api_token: { type: 'string', description: 'hidden credential field' },
    }, required: ['documentName', 'api_token'] } }] };
    const identity = { isLocalUserAssignedProfile: jest.fn(async () => true) };
    const service = createProfileSelfServiceService({
      db: db as never,
      profiles: {} as never,
      registry: { getEnabledVersion: jest.fn(async () => ({ manifest })) } as never,
      audit: {} as never,
      identity,
    });
    const actor: ProfileSelfServiceActor = { tenantId, issuer: 'https://login.example.test', userId, roleVersion: 7 };
    const page = await service.listAssignedProfileEndpoints({ limit: 20 }, actor);
    expect(identity.isLocalUserAssignedProfile).toHaveBeenCalledWith({ tenantId, userId, profileId });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ profileId, revision: 4, connectorBindings: { reasoning: { connectorId: 'ext-prompt-wizard', revision: 2 } }, parameters: { document_name: { value: 'invoice.pdf' } } });
    expect(page.items[0]?.inputSchema).toMatchObject({ properties: { documentName: { type: 'string' } }, required: ['documentName'] });
    expect(JSON.stringify(page)).not.toContain('do-not-return');
    expect(JSON.stringify(page)).not.toContain('api_token');
  });

  test('assigned API-key discovery intersects current Profile and key assignments and returns safe paged addresses', async () => {
    const keyId = '44444444-4444-4444-8444-444444444444';
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT version FROM admin_local_users')) return { rowCount: 1, rows: [{ version: 7 }] };
        if (sql.includes('count(DISTINCT k.id)')) return { rowCount: 1, rows: [{ total: 1 }] };
        if (sql.includes('SELECT DISTINCT k.id AS api_key_id')) return { rowCount: 1, rows: [{ api_key_id: keyId, name: 'Invoice test', prefix: 'du_test' }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const identity = { isLocalUserAssignedProfile: jest.fn(async () => true) };
    const service = createProfileSelfServiceService({
      db: db as never,
      profiles: {} as never,
      registry: {} as never,
      audit: {} as never,
      identity,
    });
    const actor: ProfileSelfServiceActor = { tenantId, issuer: 'https://login.example.test', userId, roleVersion: 7 };
    const page = await service.listAssignedProfileApiKeys(profileId, { query: 'invoice', limit: 10 }, actor);
    expect(identity.isLocalUserAssignedProfile).toHaveBeenCalledWith({ tenantId, userId, profileId });
    expect(page).toMatchObject({ tenantId, profileId, total: 1, items: [{ apiKeyId: keyId, name: 'Invoice test', prefix: 'du_test', status: 'ACTIVE' }] });
    const sql = db.query.mock.calls.map(([query]) => query).join('\n');
    expect(sql).toContain('admin_local_user_profile_grants');
    expect(sql).toContain('admin_local_user_api_key_grants');
    expect(JSON.stringify(page)).not.toMatch(/hash|secret|rawKey/i);
  });

  test('assigned API-key route is limited to one profile UUID and rejects traversal', () => {
    expect(matchProfilesRoute(`/profiles/assigned/${profileId}/api-keys`)).toEqual({ kind: 'assigned-api-keys', profileId });
    expect(matchProfilesRoute('/profiles/assigned/..%2Fother/api-keys')).toEqual({ kind: 'invalid' });
    expect(matchProfilesRoute('/profiles/assigned/not-a-uuid/api-keys')).toEqual({ kind: 'invalid' });
  });

  test('workflow pin canonical bytes include compiled connector recipe overrides only when admitted', () => {
    const schema = { slug: 'pin-flow', name: 'Pin flow', nodes: [{ id: 'call', type: 'connector', connector: 'ocr' }], flow: ['call'] } as const;
    const slotMap = { ocr: 'legacy-connector-00' };
    const base = canonicalLegacyWorkflowPinBytes(schema as never, slotMap);
    const pin = { ocr: { connectorId: 'ocr-v2', connectorRevision: 5, recipeDigest: `sha256:${'a'.repeat(64)}`, staticFormFields: [], extraHeaders: [] } };
    const withPin = canonicalLegacyWorkflowPinBytes(schema as never, slotMap, undefined, pin as never);
    expect(base).not.toEqual(withPin);
    expect(withPin.toString('utf8')).toContain('recipeDigest');
  });

  test('guided node override edit preserves sibling schema fields and removes empty optional values', () => {
    const schema = {
      slug: 'guided',
      nodes: [{ id: 'extract', type: 'connector', connector: 'ocr', inputs: { source: '$input.file' }, overrideConnector: { prompt: 'Old', timeoutSec: 30, extraHeaders: '[]' } }],
      flow: ['extract'],
    };
    const path = ['nodes', 0] as Array<string | number>;
    expect(connectorNodeAtPath(schema, path)?.id).toBe('extract');
    const changed = updateConnectorNodeOverride(schema, path, 'prompt', 'New {{file}}') as typeof schema;
    expect(changed.nodes[0]).toMatchObject({ connector: 'ocr', inputs: { source: '$input.file' }, overrideConnector: { prompt: 'New {{file}}', timeoutSec: 30, extraHeaders: '[]' } });
    const cleared = updateConnectorNodeOverride(changed, path, 'prompt', undefined) as typeof schema;
    expect(cleared.nodes[0]?.overrideConnector).toMatchObject({ timeoutSec: 30, extraHeaders: '[]' });
  });

  test('Admin Workbench recognizes trusted local USER only from opaque identity and checks current key plus profile grants', async () => {
    const auth = {
      kind: 'cookie', role: 'operator', tenantId, principalId: userId,
      issuer: 'du-local', roleVersion: 7, csrfOk: true,
    } as const;
    expect(trustedLocalAdminWorkbenchActor(auth as never)).toEqual({ tenantId, userId, roleVersion: 7 });
    const identity = {
      getLocalUserOperationScope: jest.fn(async () => ({
        tenantId, userId, roleVersion: 7, profileIds: [profileId], apiKeyIds: ['44444444-4444-4444-8444-444444444444'],
      })),
    };
    await expect(assertAdminWorkbenchAdmissionScope(identity, auth as never, {
      tenantId, apiKeyId: '44444444-4444-4444-8444-444444444444', profileId,
    })).resolves.toBeUndefined();
    await expect(assertAdminWorkbenchAdmissionScope(identity, auth as never, {
      tenantId, apiKeyId: '55555555-5555-4555-8555-555555555555', profileId,
    })).rejects.toMatchObject({ status: 403 });
    expect(trustedLocalAdminWorkbenchActor({
      kind: 'bearer', principal: { role: 'tenant_operator', tenantId },
    })).toBeNull();
  });

  test('Admin Workbench resolves and submits the exact endpoint-specific saved Profile', async () => {
    const apiKeyId = '44444444-4444-4444-8444-444444444444';
    const operationId = '66666666-6666-4666-8666-666666666666';
    const parameters = { task: 'classify', categories: ['TEST', 'OTHER'], text: 'synthetic' };
    const savedProfile = {
      mode: 'pinned', profileId, profileName: 'codex-ui-check-20261014', revision: 2,
      policy: { enabled: true },
    } as never;
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT id FROM api_keys')) return { rowCount: 1, rows: [{ id: apiKeyId }] };
        // PC-04/PC-05: the admission seam reads the explicit key mode.
        if (sql.includes('SELECT id, tenant_id, status, key_mode FROM api_keys')) {
          return { rowCount: 1, rows: [{ id: apiKeyId, tenant_id: tenantId, status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' }] };
        }
        if (sql.includes('SELECT version,manifest FROM business_versions')) {
          return { rowCount: 1, rows: [{ version: '1.1.0', manifest: { actions: [{ name: 'analyze' }] } }] };
        }
        if (sql.includes('SELECT endpoint_slug FROM profile_bindings')) {
          return { rowCount: 1, rows: [{ endpoint_slug: 'analyze:classify' }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const preflightLegacyWorkflow = jest.fn().mockResolvedValue(savedProfile);
    const submit = jest.fn().mockResolvedValue({ operation: { id: operationId }, replayed: false });
    const ctx = {
      db,
      submission: { preflightLegacyWorkflow, submit },
      correlationId: '77777777-7777-4777-8777-777777777777',
      audit: { record: jest.fn().mockResolvedValue(undefined) },
    } as never;
    const request = {
      tenantId,
      apiKeyId,
      businessId: 'document-core',
      businessVersion: '1.1.0',
      action: 'analyze',
      profileName: 'codex-ui-check-20261014',
      expectedProfileRevision: 2,
      endpointSlug: 'analyze:classify',
      parameters,
      artifacts: [],
    };

    await submitProfileEndpointTest(ctx, { kind: 'bearer', principal: { role: 'platform' } } as never, request, 'workbench-endpoint-test');

    expect(preflightLegacyWorkflow).toHaveBeenCalledWith(expect.objectContaining({ endpointSlug: 'analyze:classify', input: parameters }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      profileEndpointSlug: 'analyze:classify',
      legacyExpectedProfile: { profileId, revision: 2, profileName: 'codex-ui-check-20261014' },
      adminWorkbenchProfileIdentity: {
        profileId, profileName: 'codex-ui-check-20261014', revision: 2, endpointSlug: 'analyze:classify',
      },
      submission: expect.objectContaining({ input: parameters }),
    }));
  });

  test('Admin Workbench rejects an endpoint selector that differs from the saved Profile revision', async () => {
    const apiKeyId = '44444444-4444-4444-8444-444444444444';
    const savedProfile = {
      mode: 'pinned', profileId, profileName: 'codex-ui-check-20261014', revision: 2,
      policy: { enabled: true },
    } as never;
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT id FROM api_keys')) return { rowCount: 1, rows: [{ id: apiKeyId }] };
        // PC-04/PC-05: the admission seam reads the explicit key mode.
        if (sql.includes('SELECT id, tenant_id, status, key_mode FROM api_keys')) {
          return { rowCount: 1, rows: [{ id: apiKeyId, tenant_id: tenantId, status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' }] };
        }
        if (sql.includes('SELECT version,manifest FROM business_versions')) {
          return { rowCount: 1, rows: [{ version: '1.1.0', manifest: { actions: [{ name: 'analyze' }] } }] };
        }
        if (sql.includes('SELECT endpoint_slug FROM profile_bindings')) {
          return { rowCount: 1, rows: [{ endpoint_slug: null }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const preflightLegacyWorkflow = jest.fn().mockResolvedValue(savedProfile);
    const submit = jest.fn();
    const ctx = {
      db,
      submission: { preflightLegacyWorkflow, submit },
      correlationId: '77777777-7777-4777-8777-777777777777',
      audit: { record: jest.fn() },
    } as never;

    await expect(submitProfileEndpointTest(ctx, { kind: 'bearer', principal: { role: 'platform' } } as never, {
      tenantId,
      apiKeyId,
      businessId: 'document-core',
      businessVersion: '1.1.0',
      action: 'analyze',
      profileName: 'codex-ui-check-20261014',
      expectedProfileRevision: 2,
      endpointSlug: 'analyze:classify',
      parameters: { task: 'classify', categories: ['TEST', 'OTHER'], text: 'synthetic' },
      artifacts: [],
    }, 'workbench-endpoint-test')).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(preflightLegacyWorkflow).toHaveBeenCalledWith(expect.objectContaining({ endpointSlug: 'analyze:classify' }));
    expect(submit).not.toHaveBeenCalled();
  });

  test('an omitted selector is the canonical action-level Profile selector', async () => {
    const apiKeyId = '44444444-4444-4444-8444-444444444444';
    const savedProfile = {
      mode: 'pinned', profileId, profileName: 'codex-ui-check-20261014', revision: 2,
      policy: { enabled: true },
    } as never;
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT id FROM api_keys')) return { rowCount: 1, rows: [{ id: apiKeyId }] };
        // PC-04/PC-05: the admission seam reads the explicit key mode.
        if (sql.includes('SELECT id, tenant_id, status, key_mode FROM api_keys')) {
          return { rowCount: 1, rows: [{ id: apiKeyId, tenant_id: tenantId, status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' }] };
        }
        if (sql.includes('SELECT version,manifest FROM business_versions')) {
          return { rowCount: 1, rows: [{ version: '1.1.0', manifest: { actions: [{ name: 'analyze' }] } }] };
        }
        if (sql.includes('SELECT endpoint_slug FROM profile_bindings')) {
          return { rowCount: 1, rows: [{ endpoint_slug: null }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const preflightLegacyWorkflow = jest.fn().mockResolvedValue(savedProfile);
    const submit = jest.fn().mockResolvedValue({ operation: { id: '66666666-6666-4666-8666-666666666666' }, replayed: false });
    const ctx = {
      db,
      submission: { preflightLegacyWorkflow, submit },
      correlationId: '77777777-7777-4777-8777-777777777777',
      audit: { record: jest.fn().mockResolvedValue(undefined) },
    } as never;

    await submitProfileEndpointTest(ctx, { kind: 'bearer', principal: { role: 'platform' } } as never, {
      tenantId,
      apiKeyId,
      businessId: 'document-core',
      businessVersion: '1.1.0',
      action: 'analyze',
      profileName: 'codex-ui-check-20261014',
      expectedProfileRevision: 2,
      parameters: { task: 'classify', categories: ['TEST', 'OTHER'], text: 'synthetic' },
      artifacts: [],
    }, 'workbench-endpoint-test');

    expect(preflightLegacyWorkflow.mock.calls[0]?.[0]).not.toHaveProperty('endpointSlug');
    expect(submit.mock.calls[0]?.[0]).not.toHaveProperty('profileEndpointSlug');
  });

  test('malformed endpoint selectors fail contract validation before any lookup or submission', async () => {
    const query = jest.fn();
    const submit = jest.fn();
    const ctx = {
      db: { query },
      submission: { submit },
    } as never;

    await expect(submitProfileEndpointTest(ctx, { kind: 'bearer', principal: { role: 'platform' } } as never, {
      tenantId,
      apiKeyId: '44444444-4444-4444-8444-444444444444',
      businessId: 'document-core',
      businessVersion: '1.1.0',
      action: 'analyze',
      profileName: 'codex-ui-check-20261014',
      expectedProfileRevision: 2,
      endpointSlug: 'analyze/../classify',
      parameters: { text: 'synthetic' },
      artifacts: [],
    }, 'workbench-endpoint-test')).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(query).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  test('submission re-resolves the saved endpoint selector and rejects a changed Profile name before writes', async () => {
    const apiKeyId = '44444444-4444-4444-8444-444444444444';
    const queries: string[] = [];
    const db = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM submission_keys')) return { rowCount: 0, rows: [] };
        // PC-04/PC-05: the admission seam reads the explicit key mode first.
        if (sql.includes('FROM api_keys WHERE id=$1')) {
          return { rowCount: 1, rows: [{ id: apiKeyId, tenant_id: tenantId, status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' }] };
        }
        if (sql.includes('FROM business_catalog')) {
          return { rowCount: 1, rows: [{ enabled: true, activation_revision: 1, submissions_paused: false, pre_drain_version: null }] };
        }
        if (sql.includes('FROM business_versions')) {
          return { rowCount: 1, rows: [{
            version: '1.1.0', status: 'ENABLED', is_active: true, digest: 'sha256:workbench-test', queue: 'document-core',
            manifest: { actions: [{ name: 'analyze', inputSchema: { type: 'object', additionalProperties: true }, connectorSlots: [] }] },
          }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as never;
    const resolveEffectiveProfile = jest.fn().mockResolvedValue({
        mode: 'pinned', profileId, profileName: 'renamed-profile', revision: 2, bindings: {},
        policy: { enabled: true }, effectiveInput: { text: 'synthetic' },
      });
    const profiles = { resolveEffectiveProfile } as never;
    const submission = createSubmissionService(db, {} as never, profiles);

    await expect(submission.submit({
      tenantId,
      apiKeyId,
      businessId: 'document-core',
      action: 'analyze',
      idempotencyKey: 'workbench-endpoint-test',
      profileEndpointSlug: 'analyze:classify',
      legacyExpectedProfile: { profileId, revision: 2, profileName: 'codex-ui-check-20261014' },
      submission: { input: { text: 'synthetic' }, output: {} },
    })).rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });

    expect(resolveEffectiveProfile).toHaveBeenCalledWith(
      apiKeyId, 'document-core', '1.1.0', 'analyze', { text: 'synthetic' }, expect.any(Array), 'analyze:classify',
    );
    expect(queries.some((sql) => /INSERT INTO (operations|tasks|submission_keys|outbox)/i.test(sql))).toBe(false);
  });

  test('Workbench profile identity distinguishes endpoint idempotency while the same identity replays', async () => {
    const apiKeyId = '44444444-4444-4444-8444-444444444444';
    const operationId = '66666666-6666-4666-8666-666666666666';
    const input = { task: 'classify', categories: ['TEST', 'OTHER'], text: 'same request body' };
    const classifyIdentity = {
      profileId,
      profileName: 'classify-profile',
      revision: 2,
      endpointSlug: 'analyze:classify',
    };
    const sentimentIdentity = {
      profileId: '88888888-8888-4888-8888-888888888888',
      profileName: 'sentiment-profile',
      revision: 1,
      endpointSlug: 'analyze:sentiment',
    };
    const priorHash = canonicalRequestHash({
      input: { adminWorkbenchProfile: classifyIdentity, requestInput: input },
      output: {},
    });
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM submission_keys')) {
          return { rowCount: 1, rows: [{ operation_id: operationId, request_hash: priorHash }] };
        }
        if (sql.includes('FROM operations')) {
          return { rowCount: 1, rows: [{
            id: operationId, tenant_id: tenantId, business_id: 'document-core', business_version: '1.1.0',
            action: 'analyze', state: 'ACCEPTED', state_version: 1,
            created_at: '2026-10-15T00:00:00.000Z', updated_at: '2026-10-15T00:00:00.000Z', deadline_at: null,
          }] };
        }
        if (sql.includes('FROM api_keys')) {
          return { rowCount: 1, rows: [{ id: apiKeyId, tenant_id: tenantId, status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as never;
    const resolveEffectiveProfile = jest.fn();
    const service = createSubmissionService(db, {} as never, { resolveEffectiveProfile } as never);
    const makeContext = (identity: typeof classifyIdentity | typeof sentimentIdentity) => ({
      tenantId,
      apiKeyId,
      businessId: 'document-core',
      action: 'analyze',
      idempotencyKey: 'workbench-endpoint-test',
      adminWorkbenchProfileIdentity: identity,
      submission: { input, output: {} },
    });

    const replay = await service.submit(makeContext(classifyIdentity));
    expect(replay.replayed).toBe(true);
    await expect(service.submit(makeContext(sentimentIdentity))).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(resolveEffectiveProfile).not.toHaveBeenCalled();
  });
});
