/**
 * Admin Web browser harness — AWEB-03b/AWEB-05.
 *
 * Boots the real `createAdminShellServer` from source with:
 *  - the Admin Web mount enabled (per-route flag, test-mode cookie policy),
 *  - a scripted upstream stub for audit / api-keys / actions / connector
 *    revisions with scenario control (`/__stub/mode`) and a request log
 *    (`/__stub/requests`, path + tenantId + authHeaderPresent only),
 *  - an in-memory OIDC session store so operator/viewer sessions can be
 *    exercised (tenant fence + denied states) without the live IdP.
 *
 * Usage (from du-rework):
 *   pnpm dlx tsx tests/browser/admin-web/harness.ts <outfile.json>
 * Writes { url, port, token, dist, stubUrl, sessions, tenant } and stays up
 * until SIGTERM/SIGINT. Playwright reads AWEB01B_URL/TOKEN (AWEB-01b
 * compatibility), AWEB03B_STUB / AWEB03B_OPERATOR / AWEB03B_VIEWER /
 * AWEB03B_TENANT.
 */
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAdminShellServer } from '../../../services/orchestrator/src/app/admin/shell-server';
import type { AdminSessionStore, AdminSessionView } from '../../../services/orchestrator/src/modules/admin-actions/rbac';

const outFile = process.argv[2];
if (!outFile) {
  throw new Error('usage: tsx harness.ts <outfile.json>');
}

const TOKEN = 'aweb01b-browser-token';
const SECRET = 'aweb01b-browser-secret';
const DIST = resolve(__dirname, '../../../apps/admin-web/dist');

/** Tenant ids must be UUIDs (the platform queries validate them). */
const OPERATOR_TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATOR_TENANT_TOKEN = 'aweb03b-tenant-operator-token';
const OPERATOR_SESSION = 'O'.repeat(43);
const VIEWER_SESSION = 'W'.repeat(43);
const ADMIN_SESSION = 'A'.repeat(43);

type AuditMode = 'rows' | 'empty' | 'error';
type KeysMode = 'rows' | 'empty' | 'error';
type ConnectorMode = 'ok' | 'missing' | 'error';
/**
 * CONNECTOR-WIRE-B / STUB-EXT: the composed connector-management store.
 *  - `composed`: capabilities advertise `true` and the list serves real ledger rows;
 *  - `absent`:   capabilities advertise `false` and the list answers 503 (the
 *                platform's own not-configured answer — never fabricated data);
 *  - `error`:    the capabilities read itself fails (upstream 500 -> BFF 502),
 *                which the UI must render as "cannot prove capabilities" and
 *                keep every write disabled (fail-closed).
 */
type ConnectorMgmtMode = 'composed' | 'absent' | 'error';
/** How the composed store answers a `connector.*` write. */
type ConnectorWriteMode = 'ok' | 'conflict' | 'invalid';
type ProfileMode = 'placeholder' | 'fixture';
type ProfileWriteMode = 'missing' | 'ok' | 'conflict' | 'locked400' | 'partial';
type TestEndpointMode = 'missing' | 'ok';
type ReadMode = 'rows' | 'empty' | 'error';

/** One ledger row as the platform republishes it (config values arrive redacted). */
interface StubConnectorRow {
  connectorId: string;
  revision: number;
  adapter: string;
  state: 'PENDING' | 'ACTIVE' | 'RETIRED';
  config: Record<string, unknown>;
  credentialRef?: string;
  credentialSource?: Record<string, unknown>;
  tenantId?: string;
  accountId?: string;
}

interface CapturedRequest {
  method: string;
  path: string;
  tenantId: string | null;
  authHeaderPresent: boolean;
  action: string | null;
}

/** P745-UI-KEYS-JOURNEY: the exact dispatcher params for every profile.* write. */
interface CapturedWrite {
  action: string;
  params: Record<string, unknown>;
}

interface StubState {
  audit: AuditMode;
  keys: KeysMode;
  connector: ConnectorMode;
  connectorMgmt: ConnectorMgmtMode;
  connectorWrite: ConnectorWriteMode;
  connectorRows: StubConnectorRow[];
  profile: ProfileMode;
  profileWrite: ProfileWriteMode;
  testEndpoint: TestEndpointMode;
  ops: ReadMode;
  usage: ReadMode;
  biz: ReadMode;
  bizAction: 'ok' | 'error';
  crypto: 'ok' | 'unconfigured' | 'error';
  cryptoWrite: 'ok' | 'error';
  profileRevision: number;
  keysRows: {
    id: string;
    tenantId: string;
    prefix: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }[];
}

function seedKeysRows(): StubState['keysRows'] {
  return [
    {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      tenantId: OPERATOR_TENANT,
      prefix: 'du_live_ab12',
      status: 'ACTIVE',
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-01T08:00:00.000Z',
    },
  ];
}

/**
 * Seed ledger: one connector whose ACTIVE head is rev 1 and whose rev 2 is
 * PENDING, so an activate really exercises the CAS guard (expected head = 1).
 * Header values are `[REDACTED]` because that IS the wire contract.
 */
function seedConnectorRows(): StubConnectorRow[] {
  const config: Record<string, unknown> = {
    endpointUrl: 'https://api.vendor.example/v1/extract',
    headers: [
      { name: 'content-type', value: 'application/json' },
      { name: 'authorization', value: '[REDACTED]' },
    ],
  };
  const binding = {
    credentialRef: 'vault://du/vendor-extract',
    credentialSource: { kind: 'vault', mount: 'kv2', path: 'du/vendor-extract' },
    tenantId: OPERATOR_TENANT,
    accountId: 'acct-1',
  };
  return [
    { connectorId: 'vendor-extract', revision: 1, adapter: 'http-json', state: 'ACTIVE', config, ...binding },
    { connectorId: 'vendor-extract', revision: 2, adapter: 'http-json', state: 'PENDING', config, ...binding },
  ];
}

/** Scripted upstream + test-control endpoints. */
function startStub(): Promise<{ url: string; requests: CapturedRequest[]; state: StubState }> {
  const requests: CapturedRequest[] = [];
  const writes: CapturedWrite[] = [];
  const state: StubState = {
    audit: 'rows',
    keys: 'rows',
    connector: 'missing',
    connectorMgmt: 'composed',
    connectorWrite: 'ok',
    connectorRows: seedConnectorRows(),
    profile: 'placeholder',
    profileWrite: 'missing',
    testEndpoint: 'missing',
    ops: 'rows',
    usage: 'rows',
    biz: 'rows',
    bizAction: 'ok',
    crypto: 'ok',
    cryptoWrite: 'ok',
    profileRevision: 7,
    keysRows: seedKeysRows(),
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    // RFC 9457 problem+json, mirroring `problem()` in @du/contracts so the BFF
    // relay path (and the UI's single typed decoder) sees the platform shape.
    const problem = (
      status: number,
      code: string,
      title: string,
      errors?: { pointer: string; message: string }[],
    ): void => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/problem+json');
      res.end(
        JSON.stringify({
          type: `urn:du:error:${code.toLowerCase()}`,
          title,
          status,
          code,
          correlationId: 'stub-correlation-0001',
          ...(errors === undefined ? {} : { errors }),
        }),
      );
    };

    if (url.pathname === '/__stub/mode') {
      if (url.searchParams.get('reset') === '1') {
        state.audit = 'rows';
        state.keys = 'rows';
        state.connector = 'missing';
        state.connectorMgmt = 'composed';
        state.connectorWrite = 'ok';
        state.connectorRows = seedConnectorRows();
        state.profile = 'placeholder';
        state.profileWrite = 'missing';
        state.testEndpoint = 'missing';
        state.ops = 'rows';
        state.usage = 'rows';
        state.biz = 'rows';
        state.bizAction = 'ok';
        state.crypto = 'ok';
        state.cryptoWrite = 'ok';
        state.profileRevision = 7;
        state.keysRows = seedKeysRows();
        writes.length = 0;
        json(200, { reset: true });
        return;
      }
      const audit = url.searchParams.get('scenario');
      const keys = url.searchParams.get('keys');
      const connector = url.searchParams.get('connector');
      const profile = url.searchParams.get('profile');
      const profileWrite = url.searchParams.get('profileWrite');
      const testEndpoint = url.searchParams.get('testEndpoint');
      if (audit === 'rows' || audit === 'empty' || audit === 'error') state.audit = audit;
      if (keys === 'rows' || keys === 'empty' || keys === 'error') state.keys = keys;
      if (connector === 'ok' || connector === 'missing' || connector === 'error') state.connector = connector;
      const connectorMgmt = url.searchParams.get('connectorMgmt');
      const connectorWrite = url.searchParams.get('connectorWrite');
      if (connectorMgmt === 'composed' || connectorMgmt === 'absent' || connectorMgmt === 'error') {
        state.connectorMgmt = connectorMgmt;
      }
      if (connectorWrite === 'ok' || connectorWrite === 'conflict' || connectorWrite === 'invalid') {
        state.connectorWrite = connectorWrite;
      }
      if (url.searchParams.get('connectorRows') === 'reset') state.connectorRows = seedConnectorRows();
      if (profile === 'placeholder' || profile === 'fixture') state.profile = profile;
      if (profileWrite === 'missing' || profileWrite === 'ok' || profileWrite === 'conflict' || profileWrite === 'locked400' || profileWrite === 'partial') {
        state.profileWrite = profileWrite;
      }
      if (testEndpoint === 'missing' || testEndpoint === 'ok') state.testEndpoint = testEndpoint;
      const ops = url.searchParams.get('ops');
      const usage = url.searchParams.get('usage');
      const biz = url.searchParams.get('biz');
      const bizAction = url.searchParams.get('bizAction');
      if (ops === 'rows' || ops === 'empty' || ops === 'error') state.ops = ops;
      if (usage === 'rows' || usage === 'empty' || usage === 'error') state.usage = usage;
      if (biz === 'rows' || biz === 'empty' || biz === 'error') state.biz = biz;
      if (bizAction === 'ok' || bizAction === 'error') state.bizAction = bizAction;
      const crypto = url.searchParams.get('crypto');
      const cryptoWrite = url.searchParams.get('cryptoWrite');
      if (crypto === 'ok' || crypto === 'unconfigured' || crypto === 'error') state.crypto = crypto;
      if (cryptoWrite === 'ok' || cryptoWrite === 'error') state.cryptoWrite = cryptoWrite;
      json(200, {
        audit: state.audit,
        keys: state.keys,
        connector: state.connector,
        connectorMgmt: state.connectorMgmt,
        connectorWrite: state.connectorWrite,
        connectorRevisions: state.connectorRows.map((row) => `${row.connectorId}@${row.revision}:${row.state}`),
        profile: state.profile,
        profileWrite: state.profileWrite,
        testEndpoint: state.testEndpoint,
      });
      return;
    }
    if (url.pathname === '/__stub/requests') {
      json(200, { requests });
      return;
    }
    if (url.pathname === '/__stub/writes') {
      json(200, { writes });
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let action: string | null = null;
      let params: Record<string, unknown> = {};
      if (req.method === 'POST' && url.pathname === '/api/v1/admin/actions') {
        try {
          const parsed = JSON.parse(bodyText) as { action?: unknown; params?: unknown };
          action = typeof parsed.action === 'string' ? parsed.action : null;
          params =
            typeof parsed.params === 'object' && parsed.params !== null && !Array.isArray(parsed.params)
              ? (parsed.params as Record<string, unknown>)
              : {};
        } catch {
          action = null;
        }
      }
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        tenantId: url.searchParams.get('tenantId'),
        authHeaderPresent: typeof req.headers['authorization'] === 'string',
        action,
      });
      if (action !== null) writes.push({ action, params });

      // Profile detail (AWEB-04 wire freeze) -------------------------------
      const profileMatch = /^\/api\/v1\/admin\/profiles\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (profileMatch && req.method === 'GET') {
        const businessId = decodeURIComponent(profileMatch[1] ?? '');
        const businessVersion = decodeURIComponent(profileMatch[2] ?? '');
        const nameSeg = decodeURIComponent(profileMatch[3] ?? '');
        if (state.profile === 'fixture') {
          return json(200, {
            businessId,
            businessVersion,
            profileName: nameSeg === 'new' ? '' : nameSeg,
            revision: state.profileRevision,
            apiKeyId: 'aaaaaaaa-1111-4111-8111-111111111111',
            currentValues: { ai_model: 'gpt-4o' },
            policy: {
              enabled: true,
              parameters: {
                ai_model: { value: 'gpt-4o', isLocked: false },
                ai_api_key: { value: '****', isLocked: true },
              },
              jobPriority: 'MEDIUM',
              allowedFileExtensions: '.pdf,.docx',
              fileUrlAuthConfigured: true,
              connectionsOverride: [{ slug: 'openai', stepId: 'summarize' }],
            },
            manifest: { actions: [{ name: 'extract' }, { name: 'compare' }] },
            capabilities: [
              { connectorId: 'c1', capability: 'policy' },
              { connectorId: 'c1', capability: 'publish' },
              { connectorId: 'c1', capability: 'rollback' },
              { connectorId: 'c1', capability: 'testEndpoint' },
            ],
          });
        }
        return json(200, {
          businessId,
          businessVersion,
          profileName: nameSeg === 'new' ? '' : nameSeg,
          revision: 0,
          currentValues: {},
          policy: {
            enabled: true,
            parameters: {
              ai_model: { value: '', isLocked: false },
              ai_api_key: { value: '', isLocked: true },
            },
            jobPriority: 'MEDIUM',
            allowedFileExtensions: '',
            fileUrlAuthConfigured: false,
            connectionsOverride: [],
          },
          manifest: { actions: [{ name: 'extract' }] },
          capabilities: [],
        });
      }

      // Test Endpoint (T-UI-06 passthrough) --------------------------------
      if (url.pathname === '/api/v1/admin/profile-test-endpoint' && req.method === 'POST') {
        if (state.testEndpoint === 'missing') return json(404, { code: 'NOT_FOUND' });
        return json(200, { ok: true, extracted_data: { text: 'stub extraction' } });
      }

      // Audit ledger ------------------------------------------------------
      if (url.pathname === '/api/v1/admin/audit') {
        if (state.audit === 'error') return json(500, { code: 'INTERNAL' });
        const items = state.audit === 'rows' ? auditRows() : [];
        return json(200, { items, nextCursor: null, prevCursor: null, total: items.length, limit: 25 });
      }

      // API keys ----------------------------------------------------------
      if (url.pathname === '/api/v1/admin/api-keys' && req.method === 'GET') {
        if (state.keys === 'error') return json(500, { code: 'INTERNAL' });
        const items = state.keys === 'empty' ? [] : state.keysRows;
        return json(200, {
          items,
          nextCursor: null,
          prevCursor: null,
          total: items.length,
          limit: 25,
          grants: [
            {
              businessId: 'doc-core',
              businessVersion: '3',
              action: 'extract',
              grantedAt: '2026-10-01T09:00:00.000Z',
            },
          ],
          createCopyOnce: null,
        });
      }
      const keyMatch = /^\/api\/v1\/admin\/api-keys\/([^/]+)$/.exec(url.pathname);
      if (keyMatch && req.method === 'GET') {
        const row = state.keysRows.find((k) => k.id === decodeURIComponent(keyMatch[1] ?? ''));
        if (!row) return json(404, { code: 'NOT_FOUND' });
        return json(200, { items: [row], nextCursor: null, prevCursor: null, total: 1, limit: 25, grants: [], createCopyOnce: null });
      }

      // Admin actions -----------------------------------------------------
      if (url.pathname === '/api/v1/admin/actions' && req.method === 'POST') {
        if (action === 'apikey.issue') {
          const tenantId = typeof params.tenantId === 'string' ? params.tenantId : OPERATOR_TENANT;
          const issued = {
            id: 'bbbbbbbb-2222-4222-8222-222222222222',
            tenantId,
            prefix: 'du_live_new',
            status: 'ACTIVE',
            createdAt: '2026-10-04T05:00:00.000Z',
            updatedAt: '2026-10-04T05:00:00.000Z',
          };
          state.keysRows = [issued, ...state.keysRows];
          return json(201, {
            action,
            id: issued.id,
            prefix: issued.prefix,
            status: issued.status,
            rawKey: 'du_test_copy_once_raw_key_9f2c',
          });
        }
        if (action === 'apikey.revoke') {
          const apiKeyId = typeof params.apiKeyId === 'string' ? params.apiKeyId : '';
          state.keysRows = state.keysRows.map((k) =>
            k.id === apiKeyId ? { ...k, status: 'REVOKED' } : k,
          );
          return json(200, { action, id: apiKeyId, status: 'REVOKED' });
        }
        if (action === 'profile.upsert' || action === 'profile.publish' || action === 'profile.rollback') {
          if (state.profileWrite === 'missing') return json(404, { code: 'ACTION_NOT_FOUND' });
          if (state.profileWrite === 'conflict') return json(409, { code: 'REVISION_CONFLICT' });
          if (state.profileWrite === 'locked400') return json(400, { code: 'PROFILE_LOCKED_FIELD' });
          if (state.profileWrite === 'partial' && action === 'profile.upsert') {
            if (params.profileName !== 'extract') return json(422, { code: 'INVALID_SCHEMA' });
          }
          if (action === 'profile.rollback') {
            const target = typeof params.targetRevision === 'number' ? params.targetRevision : state.profileRevision;
            state.profileRevision = target;
            return json(200, { action, revision: target });
          }
          state.profileRevision += 1;
          return json(200, { action, revision: state.profileRevision });
        }
        if (action === 'prompt-override.upsert' || action === 'prompt-override.delete') {
          if (state.profileWrite === 'missing') return json(404, { code: 'ACTION_NOT_FOUND' });
          return json(200, { action, ok: true });
        }
        // CONNECTOR-WIRE-B management writes (singular `connector.*`). The
        // legacy plural `connectors.*` probes below stay untouched.
        if (
          action === 'connector.upsert' ||
          action === 'connector.activate' ||
          action === 'connector.disable' ||
          action === 'connector.retire' ||
          action === 'connector.test'
        ) {
          if (state.connectorMgmt === 'absent') {
            return problem(503, 'TEMPORARY_UNAVAILABLE', `${action}: connector management store not wired`);
          }
          if (state.connectorWrite === 'invalid') {
            return problem(422, 'INVALID_SCHEMA', `${action} params failed validation`, [
              { pointer: '/params', message: 'stub scenario forces a schema rejection' },
            ]);
          }
          if (state.connectorWrite === 'conflict') {
            return problem(409, 'STATE_CONFLICT', 'connector chain moved; refresh and retry with the current revision');
          }
          if (action === 'connector.upsert') {
            const mode = params.mode;
            const connectorId = typeof params.connectorId === 'string' ? params.connectorId : '';
            if (mode === 'create') {
              const adapter = typeof params.adapter === 'string' ? params.adapter : '';
              const credentialRef = typeof params.credentialRef === 'string' ? params.credentialRef : '';
              const config = params.config;
              if (
                connectorId === '' ||
                adapter === '' ||
                credentialRef === '' ||
                typeof config !== 'object' ||
                config === null ||
                Array.isArray(config)
              ) {
                return problem(422, 'INVALID_SCHEMA', 'connector.upsert params failed validation', [
                  {
                    pointer: '/connectorId',
                    message: 'mode create needs connectorId, adapter, credentialRef and config',
                  },
                ]);
              }
              const minted: StubConnectorRow = {
                connectorId,
                revision: 1,
                adapter,
                state: 'PENDING',
                config: config as Record<string, unknown>,
                credentialRef,
              };
              state.connectorRows.push(minted);
              // Mirrors the platform: 201 + the minted revision.
              return json(201, minted);
            }
            if (mode === 'revision') {
              const source = params.credentialSource;
              if (connectorId === '' || typeof source !== 'object' || source === null || Array.isArray(source)) {
                return problem(422, 'INVALID_SCHEMA', 'connector.upsert params failed validation', [
                  { pointer: '/credentialSource', message: 'mode revision needs a credential source' },
                ]);
              }
              const head = state.connectorRows.filter((row) => row.connectorId === connectorId).pop();
              if (head === undefined) {
                return problem(404, 'NOT_FOUND', `connector '${connectorId}' is not on the server`);
              }
              const cloned: StubConnectorRow = {
                ...head,
                revision: head.revision + 1,
                state: 'PENDING',
                credentialSource: source as Record<string, unknown>,
                ...(typeof params.tenantId === 'string' ? { tenantId: params.tenantId } : {}),
                ...(typeof params.accountId === 'string' ? { accountId: params.accountId } : {}),
              };
              state.connectorRows.push(cloned);
              return json(201, cloned);
            }
            return problem(422, 'INVALID_SCHEMA', 'connector.upsert params failed validation', [
              { pointer: '/mode', message: 'unknown mode discriminator' },
            ]);
          }
          if (action === 'connector.activate') {
            const connectorId = typeof params.connectorId === 'string' ? params.connectorId : '';
            const revision = typeof params.revision === 'number' ? params.revision : 0;
            const expected = typeof params.expectedCurrentRevision === 'number' ? params.expectedCurrentRevision : 0;
            if (connectorId === '' || revision < 1 || expected < 1) {
              return problem(422, 'INVALID_SCHEMA', 'connector.activate params failed validation', [
                { pointer: '/expectedCurrentRevision', message: 'the CAS guard is required' },
              ]);
            }
            const rows = state.connectorRows.filter((row) => row.connectorId === connectorId);
            const head = rows.filter((row) => row.state === 'ACTIVE').pop();
            if (head === undefined || head.revision !== expected || !rows.some((r) => r.revision === revision)) {
              // Real CAS semantics: a chain that moved (or a missing target) is
              // a 409 STATE_CONFLICT, never a silent success.
              return problem(409, 'STATE_CONFLICT', 'connector chain moved; refresh and retry with the current revision');
            }
            state.connectorRows = state.connectorRows.map((row) => {
              if (row.connectorId !== connectorId) return row;
              if (row.revision === revision) return { ...row, state: 'ACTIVE' as const };
              if (row.state === 'ACTIVE') return { ...row, state: 'RETIRED' as const };
              return row;
            });
            return json(200, { connectorId, revision, activated: true });
          }
          if (action === 'connector.disable') {
            const connectorId = typeof params.connectorId === 'string' ? params.connectorId : '';
            if (connectorId === '') {
              return problem(422, 'INVALID_SCHEMA', 'connector.disable params failed validation');
            }
            // The revision DTO has no DISABLED state (PENDING|ACTIVE|RETIRED),
            // so this acknowledges the connector-level disable instead of
            // fabricating a revision state the wire cannot carry.
            return json(200, { connectorId, state: 'DISABLED' });
          }
          if (action === 'connector.retire') {
            const connectorId = typeof params.connectorId === 'string' ? params.connectorId : '';
            const revision = typeof params.revision === 'number' ? params.revision : 0;
            if (connectorId === '' || revision < 1) {
              return problem(422, 'INVALID_SCHEMA', 'connector.retire params failed validation');
            }
            state.connectorRows = state.connectorRows.map((row) =>
              row.connectorId === connectorId && row.revision === revision
                ? { ...row, state: 'RETIRED' as const }
                : row,
            );
            return json(200, { connectorId, revision, state: 'RETIRED' });
          }
          // connector.test — masked probe; the platform does not audit it either.
          const connectorId = typeof params.connectorId === 'string' ? params.connectorId : '';
          if (connectorId === '') {
            return problem(422, 'INVALID_SCHEMA', 'connector.test params failed validation');
          }
          return json(200, { connectorId, ok: true });
        }
        if (action === 'connectors.test_credential') {
          if (state.connector === 'ok') return json(200, { action, ok: true });
          return json(503, { code: 'TEMPORARY_UNAVAILABLE' });
        }
        if (action === 'connectors.rotate_credential') {
          return json(503, { code: 'TEMPORARY_UNAVAILABLE' });
        }
        return json(404, { code: 'ACTION_NOT_FOUND' });
      }

      // Connector management reads -----------------------------------------
      // CONNECTOR-WIRE-B: composition-derived booleans + the real ledger list.
      // Both are matched before the revision pattern so `/connectors/
      // capabilities` can never be read as a connector id.
      if (url.pathname === '/api/v1/admin/connectors/capabilities' && req.method === 'GET') {
        if (state.connectorMgmt === 'error') return json(500, { code: 'INTERNAL' });
        const composed = state.connectorMgmt === 'composed';
        return json(200, { management: composed, credentialWorkflow: composed, test: composed });
      }
      if (url.pathname === '/api/v1/admin/connectors' && req.method === 'GET') {
        if (state.connectorMgmt === 'error') return json(500, { code: 'INTERNAL' });
        if (state.connectorMgmt === 'absent') {
          return json(503, { code: 'TEMPORARY_UNAVAILABLE', message: 'connector management store not configured' });
        }
        return json(200, { items: state.connectorRows });
      }

      // Connector revisions ------------------------------------------------
      const connectorMatch = /^\/api\/v1\/admin\/connectors\/([^/]+)\/revisions\/([^/]+)$/.exec(url.pathname);
      if (connectorMatch && req.method === 'GET') {
        if (state.connector === 'error') return json(500, { code: 'INTERNAL' });
        if (state.connector === 'missing') {
          return json(404, { code: 'NOT_FOUND', message: 'connector is not configured' });
        }
        // A composed store answers the REAL ledger revision (management shape);
        // without it the platform's endpoint-only degraded projection stays the
        // honest answer.
        if (state.connectorMgmt === 'composed') {
          const connectorId = decodeURIComponent(connectorMatch[1] ?? '');
          const revSeg = decodeURIComponent(connectorMatch[2] ?? '');
          const revisions = state.connectorRows.filter((row) => row.connectorId === connectorId);
          const row =
            revSeg === 'latest' || revSeg === 'current'
              ? revisions.filter((r) => r.state === 'ACTIVE').pop()
              : revisions.find((r) => r.revision === Number(revSeg));
          if (row === undefined) {
            return json(404, {
              code: 'NOT_FOUND',
              message: `connector '${connectorId}' revision '${revSeg}' is not on the server`,
            });
          }
          return json(200, row);
        }
        return json(200, {
          connectorId: decodeURIComponent(connectorMatch[1] ?? ''),
          revision: 1,
          adapter: 'unknown',
          endpoint: { kind: 'configured', maskedHost: 'o***:443' },
          capabilities: [],
          state: 'disabled',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          secretSlots: [],
          testResult: null,
        });
      }

      // Operations (AWEB-06) ----------------------------------------------
      if (url.pathname === '/api/v1/operations' && req.method === 'GET') {
        if (state.ops === 'error') return json(500, { code: 'INTERNAL' });
        const tenant = url.searchParams.get('tenant') ?? OPERATOR_TENANT;
        const items =
          state.ops === 'empty'
            ? []
            : [
                {
                  id: 'cccccccc-1111-4111-8111-111111111111',
                  state: 'RUNNING',
                  tenantId: tenant,
                  businessId: 'doc-core',
                  action: 'extract',
                  createdAt: '2026-10-04T04:00:00.000Z',
                  updatedAt: '2026-10-04T04:01:00.000Z',
                },
                {
                  id: 'dddddddd-2222-4222-8222-222222222222',
                  state: 'SUCCEEDED',
                  tenantId: tenant,
                  businessId: 'doc-core',
                  action: 'compare',
                  createdAt: '2026-10-04T03:00:00.000Z',
                  updatedAt: '2026-10-04T03:05:00.000Z',
                },
              ];
        return json(200, { items, nextCursor: null, prevCursor: null, total: items.length, limit: 20 });
      }
      const opDetailMatch = /^\/api\/v1\/operations\/([^/]+)$/.exec(url.pathname);
      if (opDetailMatch && req.method === 'GET') {
        const id = decodeURIComponent(opDetailMatch[1] ?? '');
        return json(200, {
          operation: {
            id,
            state: 'RUNNING',
            tenantId: OPERATOR_TENANT,
            businessId: 'doc-core',
            action: 'extract',
            createdAt: '2026-10-04T04:00:00.000Z',
            updatedAt: '2026-10-04T04:01:00.000Z',
          },
          result: { note: 'stub result' },
          artifacts: [
            { role: 'input', status: 'READY', download: '/api/v1/artifacts/a1', contentType: 'application/pdf' },
            { role: 'output', status: 'PENDING', download: null, contentType: null },
          ],
          serverNow: '2026-10-04T04:02:00.000Z',
        });
      }

      // Usage ---------------------------------------------------------------
      if (url.pathname === '/api/v1/usage' && req.method === 'GET') {
        if (url.searchParams.get('from') === null || url.searchParams.get('to') === null) {
          return json(422, { code: 'INVALID_SCHEMA' });
        }
        if (state.usage === 'error') return json(500, { code: 'INTERNAL' });
        if (state.usage === 'empty') return json(200, {});
        return json(200, {
          tenantId: url.searchParams.get('tenantId') ?? OPERATOR_TENANT,
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          requests: 12,
          tokens: 3456,
        });
      }

      // Business registry ----------------------------------------------------
      if (url.pathname === '/api/v1/admin/businesses' && req.method === 'GET') {
        if (state.biz === 'error') return json(500, { code: 'INTERNAL' });
        const items =
          state.biz === 'empty'
            ? []
            : [
                {
                  businessId: 'doc-core',
                  version: '3',
                  activeVersion: '3',
                  status: 'ENABLED',
                  isActive: true,
                  updatedAt: '2026-10-04T02:00:00.000Z',
                },
              ];
        return json(200, { items, nextCursor: null, prevCursor: null, total: items.length, limit: 50 });
      }
      const bizVersionsMatch = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions$/.exec(url.pathname);
      if (bizVersionsMatch && req.method === 'GET') {
        return json(200, {
          businessId: decodeURIComponent(bizVersionsMatch[1] ?? ''),
          activeVersion: '3',
          rows: [
            { version: '3', status: 'ENABLED', isActive: true, updatedAt: '2026-10-04T02:00:00.000Z' },
            { version: '2', status: 'DISABLED', isActive: false, updatedAt: '2026-10-03T02:00:00.000Z' },
          ],
        });
      }
      const bizActionMatch = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/(enable|activate|deactivate)$/.exec(url.pathname);
      if (bizActionMatch && req.method === 'PUT') {
        if (state.bizAction === 'error') return json(500, { code: 'INTERNAL' });
        return json(200, { ok: true, action: bizActionMatch[3], businessId: decodeURIComponent(bizActionMatch[1] ?? '') });
      }

      // Crypto config (AWEB-07) ---------------------------------------------
      if (url.pathname === '/api/v1/admin/crypto-config') {
        if (state.crypto === 'unconfigured') return json(503, { code: 'TEMPORARY_UNAVAILABLE' });
        if (state.crypto === 'error') return json(500, { code: 'INTERNAL' });
        const tenantId = url.searchParams.get('tenantId') ?? OPERATOR_TENANT;
        if (req.method === 'POST' && state.cryptoWrite === 'error') return json(500, { code: 'INTERNAL' });
        const crypto = {
          storageKeyRef: { kind: 'vault', ref: 'du-live-kek' },
          deliveryEncryption: true,
          recipientKeyVersion: 1,
          fingerprintPreview: 'ab12…cd34',
        };
        return json(200, {
          schemaVersion: '1',
          tenantId,
          ...(req.method === 'POST' ? { changedFields: ['deliveryEncryption'] } : {}),
          crypto,
        });
      }

      json(404, { code: 'NOT_FOUND' });
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolvePromise({ url: `http://127.0.0.1:${addr.port}`, requests, state });
    });
  });
}

function auditRows(): unknown[] {
  return [
    {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      kind: 'admin.profile.publish',
      severity: 'info',
      occurredAt: '2026-10-04T05:00:00.000Z',
      tenantId: OPERATOR_TENANT,
      resourceId: 'profile:doc-core',
      actor: 'user:operator-a',
      message: 'admin.profile.publish profile:doc-core',
    },
    {
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      kind: 'admin.connector.rotate_credential',
      severity: 'warning',
      occurredAt: '2026-10-04T04:30:00.000Z',
      tenantId: OPERATOR_TENANT,
      resourceId: 'connector:openai',
      actor: 'user:operator-a',
      message: 'admin.connector.rotate_credential connector:openai',
    },
  ];
}

class MapSessionStore implements AdminSessionStore {
  private readonly records = new Map<string, AdminSessionView>();
  add(sessionId: string, view: AdminSessionView): void {
    this.records.set(sessionId, view);
  }
  async get(sessionId: string): Promise<AdminSessionView | null> {
    return this.records.get(sessionId) ?? null;
  }
}

async function main(): Promise<void> {
  const stub = await startStub();
  const store = new MapSessionStore();
  store.add(ADMIN_SESSION, {
    role: 'admin',
    tenantId: OPERATOR_TENANT,
    csrfToken: 'D'.repeat(43),
    issuer: 'https://idp.harness.test',
  });
  store.add(OPERATOR_SESSION, {
    role: 'operator',
    tenantId: OPERATOR_TENANT,
    csrfToken: 'C'.repeat(43),
    issuer: 'https://idp.harness.test',
  });
  store.add(VIEWER_SESSION, {
    role: 'viewer',
    tenantId: null,
    csrfToken: 'V'.repeat(43),
    issuer: 'https://idp.harness.test',
  });

  const handle = createAdminShellServer({
    port: 0,
    host: '127.0.0.1',
    cookieSecret: SECRET,
    adminToken: TOKEN,
    adminWeb: { distDir: DIST },
    jsonBaseUrl: stub.url,
    tenantAdminTokens: { [OPERATOR_TENANT_TOKEN]: OPERATOR_TENANT },
    oidcSessions: store,
    cookiePolicy: { trustProxyProtocol: false, requireSecure: false },
  });
  const { url, port } = await handle.listen();
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        url,
        port,
        token: TOKEN,
        dist: DIST,
        stubUrl: stub.url,
        sessions: { admin: ADMIN_SESSION, operator: OPERATOR_SESSION, viewer: VIEWER_SESSION },
        tenant: OPERATOR_TENANT,
      },
      null,
      2,
    ),
  );
  console.log(`HARNESS_READY ${url} stub=${stub.url} dist=${DIST}`);

  const shutdown = (): void => {
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('HARNESS_ERROR', err);
  process.exit(2);
});
