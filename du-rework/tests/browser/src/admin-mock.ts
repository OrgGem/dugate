/**
 * W48-O5 offline verification fixtures for the 6 ADM-BASE-01 Admin
 * GETs that Claude Code landed in `services/orchestrator/dist/server.js`
 * (routes at 818 / 848 / 875 / 912 / 959 / 1010).
 *
 * WHAT THIS PROVES — AND WHAT IT DOES NOT
 * ---------------------------------------
 * The sub-server under test is the REAL `createAdminShellServer`, and
 * the section fetchers under test are the REAL platform fetchers
 * (`fetchBusinessVersions`, `fetchProfileForm`, `fetchConnectorConfig`,
 * `fetchApiKeys`, `fetchOverview`) running their REAL HTTP branch
 * (auth header, 401/403 → unauthorized, 404 → not-found, non-JSON →
 * error, payload parse → view model). The only synthetic parts are:
 *
 *   1. the HTTP endpoint — a `node:http` fixture server, not the
 *      platform; and
 *   2. the data — hand-written envelopes, not DB rows.
 *
 * Therefore this fixture proves that the renderer paints the `ok`
 * pane when the wire carries a well-formed envelope. It does NOT prove
 * anything about real DB data, and it does NOT prove the platform
 * actually serves these routes. Restated: **SYNTHETIC DATA**. Per
 * W46-O-1, no output from this fixture may be described as "live
 * verified". The envelopes below are copied field-for-field from
 * `dist/server.js` so the fetcher's parser accepts them exactly; a
 * shape drift between this fixture and the platform is itself a bug
 * the spec should catch (the fetcher would fall to `not-found`/`error`).
 *
 * NO DB. NO Redis. NO real platform HTTP.
 */

import * as http from 'node:http';

import {
  createAdminShellServer,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/index.js';
import type {
  AdminShellHandle,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/index.js';
import {
  fetchProfileForm,
  fetchConnectorConfig,
  fetchApiKeys,
  fetchOverview,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/index.js';
import {
  fetchBusinessVersions,
  type BusinessFetchResult,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/business-section-data.js';
import {
  fetchOperationDetail,
  type OperationFetchResult,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/operation-section-data.js';
import type {
  BusinessSectionFetcher,
  ProfileFetchResult,
  ProfileSectionFetcher,
  ConnectorFetchResult,
  ConnectorSectionFetcher,
  ApiKeyFetchResult,
  ApiKeySectionFetcher,
  OverviewFetchResult,
  OverviewSectionFetcher,
  OperationSectionFetcher,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/index.js';

// ---------------------------------------------------------------------------
// Stable tenant
// ---------------------------------------------------------------------------

const TENANT = 'tenant-acme';
const BUS = 'tenant-acme';
const VER = '2026.09.01';
const PROF = 'extraction-default';
const CONN = 'connector-rest-1';

export interface AdminMockHandle {
  url: string;
  port: number;
  /** Every `GET <pathname>` the fixture server answered, in order. */
  requests(): readonly string[];
  close(): Promise<void>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text, 'utf8'),
  });
  res.end(text);
}

/** `404` in the platform's error-body shape (server.ts:1022). */
function notFound(res: http.ServerResponse, detail: string): void {
  json(res, 404, {
    type: 'urn:du:error:not_found',
    title: 'not found',
    status: 404,
    code: 'NOT_FOUND',
    detail,
  });
}

/**
 * Pull a capture group from a `RegExpExecArray` as a `string`. The
 * route regexes always capture the segments they match (each route
 * below asserts the group on the same line), but
 * `noUncheckedIndexedAccess: true` widens the indexed read to
 * `string | undefined`, which `decodeURIComponent` rejects.
 * Centralising the narrowing keeps the route bodies unchanged.
 */
function group(m: RegExpExecArray, i: number): string {
  const v = m[i];
  return v ?? '';
}

/**
 * Envelopes mirror `dist/server.js` exactly. Each builder returns the
 * same fields, in the same optionality, the platform route emits.
 */
const ROUTES: ReadonlyArray<{
  /** Human label used by the spec + failure messages. */
  id: string;
  /** Regex over the request pathname. */
  match: RegExp;
  /** The exact `pathname` the spec asserts was hit (for `requests()`). */
  probe: string;
  respond(res: http.ServerResponse, m: RegExpExecArray): void;
}> = [
  {
    // GET /api/v1/admin/businesses  (server.ts:818) — bare array.
    id: 'admin-businesses-list',
    match: /^\/api\/v1\/admin\/businesses$/,
    probe: '/api/v1/admin/businesses',
    respond: (res) =>
      json(res, 200, [
        {
          businessId: BUS,
          version: VER,
          activeVersion: VER,
          status: 'ENABLED',
          isActive: true,
          registeredAt: '2026-09-12T08:15:00.000Z',
          digest: 'sha256:b1',
          queue: 'tenant-acme.jobs',
        },
        {
          businessId: 'tenant-beta',
          version: '2026.08.15',
          activeVersion: null,
          status: 'REGISTERED_DISABLED',
          isActive: false,
          registeredAt: '2026-08-15T09:00:00.000Z',
          digest: 'sha256:b2',
          queue: 'tenant-beta.jobs',
        },
      ]),
  },
  {
    // GET /api/v1/admin/businesses/:id/versions  (server.ts:848).
    id: 'admin-business-versions',
    match: /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions$/,
    probe: `/api/v1/admin/businesses/${BUS}/versions`,
    respond: (res, m) => {
      const businessId = decodeURIComponent(group(m, 1));
      if (businessId !== BUS) return notFound(res, `business '${businessId}' is not registered`);
      json(res, 200, {
        businessId,
        activeVersion: VER,
        rows: [
          {
            businessId,
            version: VER,
            status: 'ENABLED',
            isActive: true,
            registeredAt: '2026-09-12T08:15:00.000Z',
            digest: 'sha256:b1',
            queue: 'tenant-acme.jobs',
          },
          {
            businessId,
            version: '2026.08.15',
            status: 'DRAINING',
            isActive: false,
            registeredAt: '2026-08-15T09:00:00.000Z',
            digest: 'sha256:b0',
            queue: 'tenant-acme.jobs',
          },
        ],
      });
    },
  },
  {
    // GET /api/v1/admin/profiles/:b/:v/:name  (server.ts:875) — the
    // fetcher sends `latest`/`new` sentinels; actions projected from the
    // registered manifest, capabilities `[]` (no platform table yet).
    id: 'admin-profile',
    match: /^\/api\/v1\/admin\/profiles\/([^/]+)\/([^/]+)\/([^/]+)$/,
    probe: `/api/v1/admin/profiles/${BUS}/${VER}/${PROF}`,
    respond: (res, m) => {
      const businessId = decodeURIComponent(group(m, 1));
      const versionSeg = decodeURIComponent(group(m, 2));
      const nameSeg = decodeURIComponent(group(m, 3));
      if (businessId !== BUS || (versionSeg !== VER && versionSeg !== 'latest')) {
        return notFound(res, `no manifest for '${businessId}@${versionSeg}'`);
      }
      const isNew = nameSeg === 'new';
      json(res, 200, {
        businessId,
        businessVersion: VER,
        profileName: isNew ? '' : nameSeg,
        revision: 0,
        currentValues: {},
        manifest: {
          actions: [
            {
              name: 'extract',
              title: 'Extract',
              slots: [
                { name: 'pages', required: false, widget: 'text', description: 'Page range' },
                { name: 'preserveLayout', required: false, widget: 'boolean', description: 'Keep layout' },
              ],
            },
            {
              name: 'analyze',
              title: 'Analyze',
              slots: [
                { name: 'extractionModel', required: true, widget: 'text', description: 'Extraction model' },
              ],
            },
          ],
        },
        capabilities: [],
      });
    },
  },
  {
    // GET /api/v1/admin/connectors/:id/revisions/:rev  (server.ts:912) —
    // honest envelope: adapter 'unknown', capabilities [], state
    // 'disabled', secretSlots [] (secret material NEVER on the wire).
    id: 'admin-connector-revision',
    match: /^\/api\/v1\/admin\/connectors\/([^/]+)\/revisions\/([^/]+)$/,
    probe: `/api/v1/admin/connectors/${CONN}/revisions/7`,
    respond: (res, m) => {
      const connectorId = decodeURIComponent(group(m, 1));
      const revSeg = decodeURIComponent(group(m, 2));
      if (connectorId !== CONN) {
        return notFound(res, `connector '${connectorId}' is not configured`);
      }
      const revision = revSeg === 'latest' ? 1 : parseInt(revSeg, 10);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        return notFound(res, `connector '${connectorId}' revision '${revSeg}' is not on the server`);
      }
      json(res, 200, {
        connectorId,
        revision,
        adapter: 'unknown',
        endpoint: { kind: 'configured', maskedHost: 'c***.example.com' },
        capabilities: [],
        state: 'disabled',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        secretSlots: [],
        testResult: null,
      });
    },
  },
  {
    // GET /api/v1/admin/api-keys + /:keyId  (server.ts:959) — raw key is
    // NEVER on the wire; only prefix (+ maskedHint) / id / tenant / status.
    id: 'admin-api-keys',
    match: /^\/api\/v1\/admin\/api-keys(?:\/([^/]+))?$/,
    probe: '/api/v1/admin/api-keys',
    respond: (res, m) => {
      const rawKeyId = m[1];
      const keyId = rawKeyId ? decodeURIComponent(rawKeyId) : null;
      if (keyId && keyId !== 'key-001') {
        return notFound(res, `api key '${keyId}' not found`);
      }
      const rows = [
        {
          id: 'key-001',
          tenantId: TENANT,
          prefix: 'sk_live_',
          maskedHint: 'sk_live_',
          status: 'ACTIVE',
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ];
      json(res, 200, {
        rows: keyId ? rows : rows,
        grants: keyId
          ? [
              {
                businessId: BUS,
                businessVersion: VER,
                action: 'extract',
                grantedAt: '2026-09-01T00:00:00.000Z',
              },
            ]
          : [],
        createCopyOnce: null,
      });
    },
  },
  {
    // GET /api/v1/admin/audit?tenantId=…&limit=…  — real ledger envelope.
    //
    // PR-AUDIT-E (ADM-UX-04). The platform landed migration 0010
    // (`admin_audit_events`) + `createAuditService`, and the route
    // (server.ts:1337-1347) reads it via `audit.listForTenant(tenantId,
    // limit)`. Each row below is the exact `AuditWireEvent` shape
    // `toWire()` emits (modules/audit/audit.ts:70-82): id, kind,
    // severity, occurredAt, tenantId, resourceId, actor, message.
    //
    // Honest shape, mirroring the real read contract:
    //   * `profile_binding.bind` is written with the key's tenant
    //     (server.ts:1072-1079), so a real tenant-scoped read returns it
    //     today. `apikey.revoke` has no write path yet (server.ts:1060)
    //     but is a tenant-scoped kind the ledger schema supports, so a
    //     real revoke route would produce this exact row.
    //   * `business.enable` is written tenant_id NULL (server.ts:984-991)
    //     and a real `?tenantId=` read (audit.listForTenant) therefore
    //     CANNOT return it. This fixture row carries tenantId TENANT so
    //     the J4 assertion can still exercise the `business.enable` kind
    //     label — a deliberate, documented fixture liberty, NOT a claim
    //     that the platform surfaces platform-global business events to
    //     a tenant pane. See the PR-AUDIT-E report for the platform gap.
    //   * one foreign-tenant row (tenant-beta) is present to exercise the
    //     fetcher's tenant filter. It must NEVER paint in the tenant-acme
    //     pane. Note its `resourceId` is `apikey:key-beta-9`, a distinct
    //     literal the J4 journey checks for directly — the row markup
    //     carries no per-row tenantId, so the `tenant-beta` string alone
    //     could not detect a leak. The load-bearing isolation proof is the
    //     `data-audit-total` count (3, not 4).
    //
    // The fetcher filters by `tenantId` (overview-view-models.ts:408
    // `buildAuditListView`), drops rows without an id, and clamps
    // `message` to 256 chars. The fixture asserts those survive.
    id: 'admin-audit',
    match: /^\/api\/v1\/admin\/audit$/,
    probe: '/api/v1/admin/audit',
    respond: (res) =>
      json(res, 200, {
        tenantId: TENANT,
        events: [
          {
            id: 'aud-0003',
            kind: 'business.enable',
            severity: 'success',
            occurredAt: '2026-09-24T19:32:00.000Z',
            tenantId: TENANT,
            resourceId: `business:${BUS}@${VER}`,
            actor: 'admin',
            message: `business.enable business:${BUS}@${VER}`,
          },
          {
            id: 'aud-0002',
            kind: 'profile_binding.bind',
            severity: 'info',
            occurredAt: '2026-09-24T19:31:00.000Z',
            tenantId: TENANT,
            resourceId: 'apikey:key-001',
            actor: 'admin',
            message: 'profile_binding.bind apikey:key-001',
          },
          {
            id: 'aud-0001',
            kind: 'apikey.revoke',
            severity: 'warning',
            occurredAt: '2026-09-24T19:30:00.000Z',
            tenantId: TENANT,
            resourceId: 'apikey:key-001',
            actor: 'admin',
            message: 'apikey.revoke apikey:key-001',
          },
          {
            // Cross-tenant sentinel — the tenant-scoped read for TENANT
            // must NOT surface this row.
            id: 'aud-foreign-1',
            kind: 'profile_binding.bind',
            severity: 'info',
            occurredAt: '2026-09-24T19:30:30.000Z',
            tenantId: 'tenant-beta',
            resourceId: 'apikey:key-beta-9',
            actor: 'admin',
            message: 'profile_binding.bind apikey:key-beta-9',
          },
        ],
      }),
  },
  {
    // GET /api/v1/usage?tenantId=…&from=…&to=…  (server.ts:349) — admin
    // bearer branch, tenantId required. Supporting read for overview.
    id: 'usage',
    match: /^\/api\/v1\/usage$/,
    probe: '/api/v1/usage',
    respond: (res) =>
      json(res, 200, {
        tenantId: TENANT,
        from: '2026-09-23T00:00:00.000Z',
        to: '2026-09-24T00:00:00.000Z',
        rows: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            operations: 2,
            inputTokens: 1200,
            outputTokens: 400,
            pages: 17,
            costMicrousd: 3500,
            measurement: 'measured',
          },
        ],
        totals: {
          operations: 2,
          inputTokens: 1200,
          outputTokens: 400,
          pages: 17,
          costMicrousd: 3500,
        },
      }),
  },
  {
    // GET /api/v1/health  (server.ts:287) — supporting read for overview.
    id: 'health',
    match: /^\/api\/v1\/health$/,
    probe: '/api/v1/health',
    respond: (res) =>
      json(res, 200, { status: 'ok', db: true, redis: true, activeLeases: 1 }),
  },
  {
    // GET /api/v1/operations  (server.ts: ~600) — synthetic 2-row list
    // for the J1 "detect failing or waiting operation" journey.
    id: 'operations-list',
    match: /^\/api\/v1\/operations$/,
    probe: '/api/v1/operations',
    respond: (res) =>
      json(res, 200, {
        rows: [
          {
            id: 'op-failed-1',
            businessId: BUS,
            businessVersion: VER,
            action: 'extract',
            state: 'FAILED',
            createdAt: '2026-09-23T14:22:00.000Z',
            updatedAt: '2026-09-23T14:23:00.000Z',
          },
          {
            id: 'op-waiting-1',
            businessId: BUS,
            businessVersion: VER,
            action: 'analyze',
            state: 'WAITING_INPUT',
            createdAt: '2026-09-23T15:00:00.000Z',
            updatedAt: '2026-09-23T15:01:00.000Z',
          },
        ],
        total: 2,
        limit: 50,
      }),
  },
  {
    // GET /api/v1/operations/:id  (server.ts: detail) — two envelope
    // variants for J1: FAILED (error.code EXTRACT_PDF_CORRUPT) and
    // WAITING_INPUT (wait.cas). The fetcher (operation-section-data.js
    // parseFetchPayload, ~line 308) accepts both shapes via the
    // discriminated `operation.state` union.
    id: 'operations-detail',
    match: /^\/api\/v1\/operations\/([^/]+)$/,
    probe: '/api/v1/operations/op-failed-1',
    respond: (res, m) => {
      const opId = decodeURIComponent(group(m, 1));
      if (opId === 'op-failed-1') {
        return json(res, 200, {
          operation: {
            state: 'FAILED',
            id: opId,
            businessId: BUS,
            businessVersion: VER,
            action: 'extract',
            createdAt: '2026-09-23T14:22:00.000Z',
            updatedAt: '2026-09-23T14:23:00.000Z',
            progress: { percent: 100, message: 'extraction failed' },
            links: {
              self: `/api/v1/operations/${opId}`,
              replay: `/api/v1/operations/${opId}/replay`,
            },
            error: {
              code: 'EXTRACT_PDF_CORRUPT',
              title: 'PDF corrupt',
              detail: 'page 3 had no /MediaBox; aborting',
            },
          },
          artifacts: [],
          result: null,
          serverNow: '2026-09-24T19:30:00.000Z',
        });
      }
      if (opId === 'op-waiting-1') {
        return json(res, 200, {
          operation: {
            state: 'WAITING_INPUT',
            id: opId,
            businessId: BUS,
            businessVersion: VER,
            action: 'analyze',
            createdAt: '2026-09-23T15:00:00.000Z',
            updatedAt: '2026-09-23T15:01:00.000Z',
            progress: { percent: 42, message: 'awaiting human input' },
            links: {
              self: `/api/v1/operations/${opId}`,
              resume: `/api/v1/operations/${opId}/resume`,
            },
            wait: {
              waitId: 'g2jurZAAAAA',
              inputSchema: { type: 'object', properties: { column: { type: 'string' } } },
              expiresAt: '2026-09-25T15:01:00.000Z',
            },
          },
          artifacts: [],
          result: null,
          serverNow: '2026-09-24T19:30:00.000Z',
        });
      }
      notFound(res, `operation '${opId}' not found`);
    },
  },
];

export async function startAdminMock(): Promise<AdminMockHandle> {
  const log: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = u.pathname;
    log.push(`${req.method ?? 'GET'} ${p}`);
    for (const route of ROUTES) {
      const m = route.match.exec(p);
      if (m) return route.respond(res, m);
    }
    notFound(res, `mock has no route for '${p}'`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock server failed to bind');
  const port = addr.port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests: () => log,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Route id → exact pathname the spec asserts was hit. */
export const ROUTE_PROBES = ROUTES.filter((r) => r.id.startsWith('admin-')).map((r) => ({
  id: r.id,
  path: r.probe,
}));

// ---------------------------------------------------------------------------
// Real fetchers, pointed at the fixture server
// ---------------------------------------------------------------------------

/**
 * The 6 section fetchers the harness needs, each delegating to the REAL
 * platform fetcher with `jsonBaseUrl` set to the fixture server. This is
 * the same "delegate to platform code" pattern `stubs.ts` uses — the
 * delta here is `jsonBaseUrl` is non-empty, so the fetcher takes its
 * HTTP branch rather than the in-process catalog branch.
 */
export function wireFetchersToMock(mockUrl: string) {
  const token = 'harness-secret-token';
  return {
    businesses: (async (input): Promise<BusinessFetchResult> =>
      fetchBusinessVersions({
        businessId: input.businessId,
        jsonBaseUrl: mockUrl,
        adminToken: token,
        nowMs: input.nowMs,
      })) as BusinessSectionFetcher,
    profiles: (async (input): Promise<ProfileFetchResult> =>
      fetchProfileForm({
        businessId: input.businessId,
        businessVersion: input.businessVersion,
        profileName: input.profileName,
        jsonBaseUrl: mockUrl,
        adminToken: token,
      })) as ProfileSectionFetcher,
    connectors: (async (input): Promise<ConnectorFetchResult> =>
      fetchConnectorConfig({
        connectorId: input.connectorId,
        revision: input.revision,
        jsonBaseUrl: mockUrl,
        adminToken: token,
      })) as ConnectorSectionFetcher,
    apiKeys: (async (input): Promise<ApiKeyFetchResult> =>
      fetchApiKeys({
        keyId: input.keyId,
        jsonBaseUrl: mockUrl,
        adminToken: token,
      })) as ApiKeySectionFetcher,
    overview: (async (input): Promise<OverviewFetchResult> =>
      fetchOverview({
        tenantId: input.tenantId,
        from: input.from,
        to: input.to,
        jsonBaseUrl: mockUrl,
        adminToken: token,
      })) as OverviewSectionFetcher,
    operations: (async (input): Promise<OperationFetchResult> =>
      fetchOperationDetail({
        operationId: input.operationId,
        jsonBaseUrl: mockUrl,
        adminToken: token,
      })) as OperationSectionFetcher,
  };
}

export interface VerifyHarnessHandle {
  url: string;
  port: number;
  mock: AdminMockHandle;
  close(): Promise<void>;
}

/**
 * Boot the fixture server + the REAL Admin shell sub-server, with every
 * section fetcher pointed at the fixture. `operationId`-driven
 * operations section is intentionally absent: `/api/v1/operations/:id`
 * is NOT one of the 6 ADM-BASE-01 routes under test.
 */
export async function startVerifyHarness(): Promise<VerifyHarnessHandle> {
  const mock = await startAdminMock();
  const handle: AdminShellHandle = createAdminShellServer({
    port: 0,
    host: '127.0.0.1',
    cookieSecret: 'harness-cookie-secret-32-bytes-or-more',
    adminToken: 'harness-secret-token',
    sectionFetchers: wireFetchersToMock(mock.url),
  });
  const { url } = await handle.listen();
  return {
    url,
    port: handle.port,
    mock,
    close: async () => {
      await handle.close();
      await mock.close();
    },
  };
}