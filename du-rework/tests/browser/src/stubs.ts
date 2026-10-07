/**
 * Stub fetchers for the W47-O browser harness.
 *
 * Each section fetcher delegates to the platform's real
 * `fetchXxx` function, driven by an in-process catalog. The
 * renderer therefore receives shapes produced by platform code,
 * never hand-built literals — the test cannot pass against a
 * shape the platform does not actually emit.
 *
 * NO DB, NO Redis, NO platform HTTP. The platform's
 * `fetchBusinessVersions` has no offline catalog path, so it is
 * driven via an injectable `fetchImpl` that returns a synthetic
 * `Response`. The remaining fetchers (`fetchProfileForm`,
 * `fetchConnectorConfig`, `fetchApiKeys`, `fetchOperationDetail`,
 * `fetchOverview`) all accept a `manifestCatalog` parameter and
 * use it when `jsonBaseUrl` is empty.
 */

import * as fs from 'node:fs';

function traceStub(msg: string): void {
  try {
    fs.appendFileSync(
      'D:/Git/dugate/du-rework/tests/browser/artifacts/stub-trace.log',
      `[${new Date().toISOString()}] ${msg}\n`,
    );
  } catch {
    // best-effort tracing
  }
}

import {
  fetchProfileForm,
  fetchConnectorConfig,
  fetchApiKeys,
  fetchOperationDetail,
  fetchOverview,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/index.js';
import {
  fetchBusinessVersions,
  type BusinessFetchResult,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/business-section-data.js';
import type {
  BusinessSectionFetcher,
  ProfileFetchResult,
  ProfileSectionFetcher,
  ConnectorFetchResult,
  ConnectorSectionFetcher,
  ApiKeyFetchResult,
  ApiKeySectionFetcher,
  OperationFetchResult,
  OperationSectionFetcher,
  OverviewFetchResult,
  OverviewSectionFetcher,
} from '../../../orchestrator/services/orchestrator/dist/app/admin/index.js';

// ---------------------------------------------------------------------------
// Businesses (fetchImpl-driven — fetchBusinessVersions has no catalog path)
// ---------------------------------------------------------------------------

const BUSINESS_ROWS = [
  {
    businessId: 'tenant-acme',
    version: '2026.09.01',
    status: 'ENABLED',
    isActive: true,
    registeredAt: '2026-09-12T08:15:00.000Z',
    lastHeartbeatAt: '2026-09-24T01:10:00.000Z',
    workerHealth: 'HEALTHY',
    workerCount: 3,
    digest: 'sha256:b1',
    queue: 'tenant-acme.jobs',
  },
  {
    businessId: 'tenant-acme',
    version: '2026.08.15',
    status: 'DRAINING',
    isActive: false,
    registeredAt: '2026-08-15T09:00:00.000Z',
    lastHeartbeatAt: '2026-09-23T20:42:00.000Z',
    workerHealth: 'DEGRADED',
    workerCount: 1,
    digest: 'sha256:b2',
    queue: 'tenant-acme.jobs',
  },
  {
    businessId: 'tenant-acme',
    version: '2026.07.30',
    status: 'RETIRED',
    isActive: false,
    registeredAt: '2026-07-30T12:00:00.000Z',
    lastHeartbeatAt: null,
    workerHealth: 'OFFLINE',
    workerCount: undefined,
    digest: 'sha256:b3',
    queue: 'tenant-acme.jobs.archive',
  },
];

export const businessesStub: BusinessSectionFetcher = async (
  input,
): Promise<BusinessFetchResult> => {
  const businessId = input.businessId.length > 0 ? input.businessId : 'tenant-acme';
  const activeVersion =
    BUSINESS_ROWS.find((r) => r.businessId === businessId && r.isActive)?.version ?? null;
  const rows = BUSINESS_ROWS.filter((r) => r.businessId === businessId);
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ businessId, activeVersion, rows }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  return fetchBusinessVersions({
    businessId,
    jsonBaseUrl: 'http://127.0.0.1:0',
    adminToken: 'harness-secret-token',
    fetchImpl,
  });
};

// ---------------------------------------------------------------------------
// Profiles (manifestCatalog-driven)
// ---------------------------------------------------------------------------

export const profilesStub: ProfileSectionFetcher = async (
  input,
): Promise<ProfileFetchResult> => {
  const businessId =
    input.businessId.length > 0 ? input.businessId : 'tenant-acme';
  const businessVersion =
    input.businessVersion && input.businessVersion.length > 0
      ? input.businessVersion
      : '2026.09.01';
  const profileName =
    input.profileName && input.profileName.length > 0
      ? input.profileName
      : 'extraction-default';
  return fetchProfileForm({
    businessId,
    businessVersion,
    profileName,
    jsonBaseUrl: '',
    adminToken: 'harness-secret-token',
    manifestCatalog: [
      {
        businessId,
        businessVersion,
        capabilityOptions: [],
        existingProfile: { name: profileName, revision: 7 },
        manifest: {
          actions: [
            {
              name: 'extract',
              title: 'Extract',
              slots: [
                { name: 'pages', required: false, widget: 'text', description: 'Pages' },
                { name: 'preserveLayout', required: false, widget: 'boolean', description: 'Preserve layout' },
              ],
            },
            {
              name: 'analyze',
              title: 'Analyze',
              slots: [
                { name: 'extractionModel', required: true, widget: 'text', description: 'Extraction model' },
                { name: 'fusion-turbo', required: false, widget: 'fusion-turbo', description: 'Fusion turbo (unknown)' },
              ],
            },
          ],
        },
      },
    ],
  });
};

// ---------------------------------------------------------------------------
// Connectors (manifestCatalog-driven)
// ---------------------------------------------------------------------------

export const connectorsStub: ConnectorSectionFetcher = async (
  input,
): Promise<ConnectorFetchResult> => {
  const connectorId =
    input.connectorId.length > 0 ? input.connectorId : 'connector-rest-1';
  const revision = input.revision > 0 ? input.revision : 7;
  return fetchConnectorConfig({
    connectorId,
    revision,
    jsonBaseUrl: '',
    adminToken: 'harness-secret-token',
    manifestCatalog: [
      {
        connectorId,
        revision,
        adapter: 'rest',
        endpoint: { kind: 'REST', maskedHost: '***.example.com' },
        capabilities: ['text', 'markdown'],
        state: 'enabled',
        createdAt: '2026-09-10T10:00:00.000Z',
        updatedAt: '2026-09-22T16:00:00.000Z',
        secretSlots: [
          { name: 'apiKey', label: 'API key', hasValue: true, rotatedAt: null },
          { name: 'webhookSecret', label: 'Webhook secret', hasValue: false, rotatedAt: null },
        ],
        testResult: {
          kind: 'success',
          message: 'Connected to upstream in 134 ms.',
          testedAt: '2026-09-23T18:00:00.000Z',
        },
        rotateState: 'idle',
      },
    ],
  });
};

// ---------------------------------------------------------------------------
// API keys (manifestCatalog-driven; copy-once window for `expired-copy-once`)
// ---------------------------------------------------------------------------

export const apiKeysStub: ApiKeySectionFetcher = async (
  input,
): Promise<ApiKeyFetchResult> => {
  const isCopyOnce = input.keyId === 'expired-copy-once';
  return fetchApiKeys({
    keyId: input.keyId,
    jsonBaseUrl: '',
    adminToken: 'harness-secret-token',
    manifestCatalog: {
      entries: isCopyOnce
        ? [
            // The copy-once pane must coexist with a non-empty entry list
            // for `keyId="expired-copy-once"`, otherwise `fetchApiKeys`
            // short-circuits to `kind: 'empty'` (see
            // `api-key-section-data.ts:249-258`) before reaching
            // `buildOkFromCatalog`, which is what surfaces
            // `pendingCreateCopyOnce` into the renderer. The entry
            // exists only to satisfy the catalog-length guard; the
            // masked-hint pane paints the copy-once contract, NOT the
            // list row, so the row is in a "key has been revoked but
            // its copy-once window is still pending acknowledgement"
            // state — semantically consistent with the W47-O12
            // interaction-3 scenario.
            {
              id: 'expired-copy-once',
              tenantId: 'tenant-acme',
              maskedHint: 'sk_****-****-****-****',
              prefix: 'sk_3secret',
              status: 'REVOKED',
              createdAt: '2026-09-24T01:00:00.000Z',
              lastUsedAt: null,
              label: null,
              revokedAt: '2026-09-24T01:05:00.000Z',
              grants: [],
            },
          ]
        : [
            {
              id: 'key-1',
              tenantId: 'tenant-acme',
              maskedHint: 'sk_****-****-****-a1b2',
              prefix: 'sk_a1b2',
              status: 'ACTIVE',
              createdAt: '2026-09-12T08:15:00.000Z',
              lastUsedAt: '2026-09-24T00:30:00.000Z',
              label: 'production',
              revokedAt: null,
              grants: [
                {
                  businessId: 'tenant-acme',
                  businessVersion: '2026.09.01',
                  action: 'ingest',
                  grantedAt: '2026-09-12T08:20:00.000Z',
                },
                {
                  businessId: 'tenant-acme',
                  businessVersion: '2026.09.01',
                  action: 'extract',
                  grantedAt: '2026-09-13T09:00:00.000Z',
                },
              ],
            },
            {
              id: 'key-2',
              tenantId: 'tenant-acme',
              maskedHint: 'sk_****-****-****-c3d4',
              prefix: 'sk_c3d4',
              status: 'REVOKED',
              createdAt: '2026-08-01T10:00:00.000Z',
              lastUsedAt: '2026-09-10T11:00:00.000Z',
              label: 'staging',
              revokedAt: '2026-09-15T12:00:00.000Z',
              grants: [],
            },
          ],
      pendingCreateCopyOnce: isCopyOnce
        ? {
            id: 'create-window-1',
            tenantId: 'tenant-acme',
            maskedHint: 'sk_****-****-****-****',
            prefix: 'sk_3secret',
            label: null,
            createdAt: '2026-09-24T01:00:00.000Z',
            copyOnceAvailable: true,
            copyOnceNotice: 'Copy this key now — it will not be shown again.',
          }
        : null,
    },
  });
};

// ---------------------------------------------------------------------------
// Operations (manifestCatalog-driven; expired CAS for `op-wait`)
// ---------------------------------------------------------------------------

export const operationsStub: OperationSectionFetcher = async (
  input,
): Promise<OperationFetchResult> => {
  traceStub(`operationsStub called operationId=${JSON.stringify(input.operationId)}`);
  // eslint-disable-next-line no-console
  console.log(`[W47-O STUB] operationsStub called operationId=${JSON.stringify(input.operationId)}`);
  // serverNow is intentionally AFTER the op-wait expiresAt so the
  // fetcher derives isExpired=true. The renderer's hidden casToken
  // input is bound to waitId, so we set waitId='cas-1' to satisfy
  // interaction-2's value assertion.
  const serverNow = '2026-09-25T00:00:00.000Z';
  return fetchOperationDetail({
    operationId: input.operationId,
    jsonBaseUrl: '',
    adminToken: 'harness-secret-token',
    manifestCatalog: {
      serverNow,
      entries: [
        {
          operation: {
            id: 'op-running',
            tenantId: 'tenant-acme',
            businessId: 'tenant-acme',
            businessVersion: '2026.09.01',
            action: 'extract',
            state: 'RUNNING',
            stateVersion: 4,
            createdAt: '2026-09-24T00:50:00.000Z',
            updatedAt: '2026-09-24T01:05:00.000Z',
            deadlineAt: '2026-09-24T01:30:00.000Z',
            replayOf: null,
            progress: { percent: 60, message: 'Extracting pages 1-12 of 20' },
            links: {
              self: '/api/v1/operations/op-running',
              result: '/api/v1/operations/op-running/result',
            },
          },
          result: null,
          artifacts: [],
        },
        {
          operation: {
            id: 'op-wait',
            tenantId: 'tenant-acme',
            businessId: 'tenant-acme',
            businessVersion: '2026.09.01',
            action: 'compare',
            state: 'WAITING_INPUT',
            stateVersion: 2,
            createdAt: '2026-09-24T00:00:00.000Z',
            updatedAt: '2026-09-24T00:30:00.000Z',
            deadlineAt: '2026-09-25T00:00:00.000Z',
            replayOf: null,
            progress: { percent: 50, message: 'Awaiting operator input' },
            links: {
              self: '/api/v1/operations/op-wait',
              result: '/api/v1/operations/op-wait/result',
            },
            wait: {
              waitId: 'cas-1',
              inputSchema: {
                type: 'object',
                required: ['notes'],
                properties: {
                  notes: {
                    type: 'string',
                    description: 'Operator notes',
                    'ui:widget': 'textarea',
                  },
                  callbackUrl: {
                    type: 'string',
                    description: 'Optional callback override',
                  },
                },
              },
              uiSchema: {},
              expiresAt: '2026-09-24T00:00:00.000Z',
            },
          },
          result: null,
          artifacts: [],
        },
        {
          operation: {
            id: 'op-succeeded',
            tenantId: 'tenant-acme',
            businessId: 'tenant-acme',
            businessVersion: '2026.09.01',
            action: 'ingest',
            state: 'SUCCEEDED',
            stateVersion: 3,
            createdAt: '2026-09-23T22:00:00.000Z',
            updatedAt: '2026-09-23T22:01:00.000Z',
            deadlineAt: null,
            replayOf: null,
            progress: { percent: 100, message: 'Completed' },
            links: {
              self: '/api/v1/operations/op-succeeded',
              result: '/api/v1/operations/op-succeeded/result',
            },
          },
          result: {
            schemaVersion: '1',
            data: { summary: 'Ingested 17 pages', warnings: [] },
            artifacts: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              costMicrousd: 0,
              measurement: 'measured',
            },
            warnings: [],
          },
          artifacts: [
            {
              artifactId: 'artifact-1',
              role: 'primary',
              fileName: 'op-succeeded.json',
              mimeType: 'application/json',
              sizeBytes: 4096,
              download: '/api/runtime/v1/artifacts/blob/abc?grant=g1',
            },
          ],
        },
      ],
    },
  });
};

// ---------------------------------------------------------------------------
// Overview (manifestCatalog-driven)
// ---------------------------------------------------------------------------

export const overviewStub: OverviewSectionFetcher = async (
  input,
): Promise<OverviewFetchResult> => {
  const tenantId = input.tenantId.length > 0 ? input.tenantId : 'tenant-acme';
  const from = input.from ?? '2026-09-23T00:00:00.000Z';
  const to = input.to ?? '2026-09-24T00:00:00.000Z';
  return fetchOverview({
    tenantId,
    from,
    to,
    jsonBaseUrl: '',
    adminToken: 'harness-secret-token',
    manifestCatalog: {
      usageSummary: {
        tenantId,
        from,
        to,
        rows: [
          {
            provider: 'openai',
            model: 'gpt-4o-mini',
            operations: 7,
            inputTokens: 5000,
            outputTokens: 2500,
            pages: 5,
            costMicrousd: 250000,
            measurement: 'measured',
          },
          {
            provider: 'anthropic',
            model: 'claude-3-haiku',
            operations: 5,
            inputTokens: 3000,
            outputTokens: 1500,
            pages: 4,
            costMicrousd: 175000,
            measurement: 'estimated',
          },
        ],
        totals: {
          operations: 12,
          inputTokens: 8000,
          outputTokens: 4000,
          pages: 9,
          costMicrousd: 425000,
        },
      },
      auditEvents: {
        tenantId,
        events: [
          {
            id: 'evt-1',
            kind: 'apikey.create',
            occurredAt: '2026-09-24T00:55:00.000Z',
            tenantId,
            resourceId: 'key-1',
            actor: 'system',
            message: 'admin logged in',
          },
          {
            id: 'evt-2',
            kind: 'apikey.revoke',
            occurredAt: '2026-09-24T01:02:00.000Z',
            tenantId,
            resourceId: 'key-2',
            actor: 'admin',
            message: 'profile updated',
          },
        ],
      },
      health: {
        status: 'degraded',
        db: false,
        redis: true,
        activeLeases: 4,
      },
    },
  });
};

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export interface StubSectionFetchers {
  businesses: BusinessSectionFetcher;
  profiles: ProfileSectionFetcher;
  connectors: ConnectorSectionFetcher;
  apiKeys: ApiKeySectionFetcher;
  operations: OperationSectionFetcher;
  overview: OverviewSectionFetcher;
}

export const stubFetchers: StubSectionFetchers = {
  businesses: businessesStub,
  profiles: profilesStub,
  connectors: connectorsStub,
  apiKeys: apiKeysStub,
  operations: operationsStub,
  overview: overviewStub,
};

traceStub(`stubFetchers built keys=${Object.keys(stubFetchers).join(',')} typeof.operations=${typeof operationsStub}`);