import { createHash } from 'node:crypto';
import { expect, type Page, type Route } from '@playwright/test';
import type { AdminWebSession, OperationDetail } from '../../../orchestrator/apps/admin-web/src/lib/api/types';
import { IdentitySnapshotSchema, IdentityUserSchema } from '../../../orchestrator/packages/contracts/dist/identity';
import { IdentityAssignmentSetSchema, IdentityUserPageSchema, ApiKeyLifecyclePageSchema, ParityIdentityUserResponseSchema } from '../../../orchestrator/packages/contracts/dist/parity';
import { OperationsListPageSchema } from '../../../orchestrator/packages/contracts/dist/public-api';
import { IncidentDetailSchema, IncidentListPageSchema, MaintenanceSuppressionListSchema } from '../../../orchestrator/packages/contracts/dist/incidents';
import { MaintenanceJobSchema, MaintenancePreviewSchema, QueueInventorySchema, ServiceInventorySchema } from '../../../orchestrator/packages/contracts/dist/maintenance';
import { ProfileSelfServiceAssignedApiKeyPageSchema, ProfileSelfServiceAssignedPageSchema, ProfileSelfServiceEditResponseSchema } from '../../../orchestrator/packages/contracts/dist/profile-self-service';
import { ConnectorCapabilitiesSchema } from '../../../orchestrator/packages/contracts/dist/connector-management';

export const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
export const PROFILE_ONE = '33333333-3333-4333-8333-333333333331';
export const PROFILE_TWO = '33333333-3333-4333-8333-333333333332';
export const KEY_ONE = '44444444-4444-4444-8444-444444444441';
export const KEY_TWO = '44444444-4444-4444-8444-444444444442';
export const USER_ID = '55555555-5555-4555-8555-555555555551';
export const INCIDENT_ID = '66666666-6666-4666-8666-666666666661';
export const INCIDENT_EVENT_ID = '77777777-7777-4777-8777-777777777771';
export const INCIDENT_RECOVERY_EVENT_ID = '77777777-7777-4777-8777-777777777772';
export const OPERATION_ONE = '88888888-8888-4888-8888-888888888881';
export const NEXT_OPERATION_CURSOR = 'orv14-ops-page-two';
export const FIXTURE_TIME = '2026-10-12T00:00:00.000Z';

const BASE = process.env.AWEB01B_URL ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';

export interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  /** Kept in memory for exact request assertions; never emitted to raw logs. */
  body: unknown;
  csrfPresent: boolean;
  idempotencyKeyPresent: boolean;
}

export interface ApiReply {
  status?: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface ApiFixture {
  calls: ApiCall[];
  unhandled: string[];
  servedAssets: Array<{ url: string; sha256: string }>;
}

export type ApiResponder = (call: ApiCall) => ApiReply | undefined | Promise<ApiReply | undefined>;

interface RuntimeSchema<T> { parse(value: unknown): T; }

export function checked<T>(schema: RuntimeSchema<T>, value: unknown): T {
  return schema.parse(value);
}

export function platformAdminSession(): AdminWebSession {
  return {
    schemaVersion: '1', plane: 'oidc', role: 'admin',
    principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' },
    displayName: 'orv14-platform-admin', localUser: false, csrfToken: 'orv14-fixture-csrf',
  };
}

export function tenantUserSession(): AdminWebSession {
  return {
    schemaVersion: '1', plane: 'legacy', role: 'operator',
    principal: { kind: 'tenant_operator', tenantId: TENANT_ID }, scope: { kind: 'tenant', tenantId: TENANT_ID },
    displayName: 'orv14-local-user', localUser: true, csrfToken: 'orv14-fixture-csrf',
  };
}

export async function installAdminApi(page: Page, responder: ApiResponder, session = platformAdminSession()): Promise<ApiFixture> {
  const fixture: ApiFixture = { calls: [], unhandled: [], servedAssets: [] };
  page.on('response', async (response) => {
    if (!/\/admin\/assets\/.*\.(?:js|css)(?:\?|$)/.test(response.url())) return;
    try {
      const body = await response.body();
      fixture.servedAssets.push({ url: response.url(), sha256: createHash('sha256').update(body).digest('hex') });
    } catch { /* navigation assertion reports failed asset loads */ }
  });

  await page.route('**/admin/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = undefined;
    if (request.postData() !== null) {
      try { body = request.postDataJSON(); } catch { body = '[non-json-body]'; }
    }
    const headers = request.headers();
    const call: ApiCall = {
      method: request.method(), path: url.pathname, query: url.searchParams, body,
      csrfPresent: headers['x-csrf-token'] === 'orv14-fixture-csrf',
      idempotencyKeyPresent: typeof headers['idempotency-key'] === 'string' && headers['idempotency-key'].length > 0,
    };
    fixture.calls.push(call);

    let reply: ApiReply | undefined;
    if (call.method === 'GET' && call.path === '/admin/api/session') reply = { body: session };
    else if (call.method === 'GET' && call.path === '/admin/api/tenants') reply = { body: {
      items: [{ id: TENANT_ID, name: 'ORV14 verifier tenant', state: 'ACTIVE' }],
      nextCursor: null, prevCursor: null, total: 1, limit: 100,
    } };
    else if (call.method === 'GET' && call.path === '/admin/api/health') reply = { body: {
      status: 'ok', db: true, redis: true, activeLeases: 0,
      queueIntegrity: { state: 'OK', orphansLast: 0, stalled: 0, lastSweepAt: FIXTURE_TIME },
      outboxBacklog: 0, sampledAt: FIXTURE_TIME,
    } };
    else reply = await responder(call);

    if (!reply) {
      fixture.unhandled.push(`${call.method} ${call.path}`);
      reply = { status: 501, body: { type: 'urn:du:error:orv14_fixture_unhandled', title: 'Verifier fixture has no response for this route.', status: 501, code: 'FIXTURE_UNHANDLED' } };
    }
    const status = reply.status ?? 200;
    const contentType = reply.contentType ?? 'application/json; charset=utf-8';
    const serialized = typeof reply.body === 'string' || Buffer.isBuffer(reply.body) ? reply.body : JSON.stringify(reply.body);
    await route.fulfill({ status, contentType, headers: reply.headers, body: serialized });
  });
  return fixture;
}

export async function signInAndOpen(page: Page, route: string): Promise<void> {
  if (!BASE || !TOKEN) throw new Error('AWEB01B_URL/AWEB01B_TOKEN must point at the normal private Admin shell');
  await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), TENANT_ID);
  await page.goto(`${BASE}admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[name="token"]')).toBeVisible();
  await page.locator('input[name="token"]').fill(TOKEN);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === '/admin');
  await page.goto(`${BASE}admin/${route}`, { waitUntil: 'networkidle' });
}

export function logServedAssets(fixture: ApiFixture, label: string): void {
  const unique = [...new Map(fixture.servedAssets.map((asset) => [asset.url, asset])).values()];
  console.info(`${label}_SERVED_ASSETS ${JSON.stringify(unique)}`);
}

export function tenantSessionApi(path: string): string {
  return `${path}?tenantId=${TENANT_ID}`;
}

export function operationsPage(cursor?: string | null, state = 'SUCCEEDED') {
  const first = cursor ? 21 : 1;
  const items = Array.from({ length: 20 }, (_, index) => {
    const sequence = first + index;
    const suffix = sequence.toString(16).padStart(12, '0');
    return {
      id: sequence === 1 ? OPERATION_ONE : `90000000-0000-4000-8000-${suffix}`,
      state, tenantId: TENANT_ID, businessId: 'document-core', action: 'extract',
      createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME, completedAt: FIXTURE_TIME,
    };
  });
  return checked(OperationsListPageSchema, {
    items, total: 1005, limit: 20, nextCursor: cursor ? null : NEXT_OPERATION_CURSOR,
    prevCursor: cursor ? 'orv14-ops-page-one' : null,
  });
}

export function operationDetail(): OperationDetail {
  return {
    operation: {
      id: OPERATION_ONE, state: 'SUCCEEDED', tenantId: TENANT_ID,
      businessId: 'document-core', action: 'extract',
      createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME,
      startedAt: FIXTURE_TIME, completedAt: FIXTURE_TIME,
      correlationId: 'orv14-correlation-001',
    } as OperationDetail['operation'],
    tasks: [], resultSummary: JSON.stringify({ accepted: true }),
    artifacts: [{ role: 'output', status: 'READY', downloadUrl: `/admin/api/operations/${OPERATION_ONE}/download`, contentType: 'application/json' }],
    serverNow: FIXTURE_TIME,
    raw: { accepted: true },
  } as OperationDetail;
}

export function identitySnapshot() {
  return checked(IdentitySnapshotSchema, {
    users: [], capabilities: { userWriter: true },
    auth: { mode: 'both', localEnabled: true, oidc: null },
  });
}

export function identityUser(input: Partial<{ enabled: boolean; version: number; legacyPasswordResetRequired: boolean }> = {}) {
  return checked(IdentityUserSchema, {
    id: USER_ID, username: 'orv14-local-user', role: 'USER',
    enabled: input.enabled ?? true, locked: false,
    legacyPasswordResetRequired: input.legacyPasswordResetRequired ?? false,
    createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME, version: input.version ?? 4,
  });
}

export function identityUserPage(user: Record<string, unknown>) {
  return checked(IdentityUserPageSchema, { items: [user], nextCursor: null, prevCursor: null, total: 1, limit: 100 });
}

export function identityUserMutationResult(user: Record<string, unknown>) {
  return checked(ParityIdentityUserResponseSchema, { user });
}

export function identityAssignments(version: number, profileIds: string[], apiKeyIds: string[]) {
  return checked(IdentityAssignmentSetSchema, { userId: USER_ID, version, profileIds, apiKeyIds });
}

export function apiKeyLifecyclePage() {
  return checked(ApiKeyLifecyclePageSchema, {
    items: [
      { id: KEY_ONE, tenantId: TENANT_ID, prefix: 'du_live_orv14_1', note: 'primary', status: 'ACTIVE', version: 1, createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME, profileIds: [PROFILE_ONE], protected: false },
      { id: KEY_TWO, tenantId: TENANT_ID, prefix: 'du_live_orv14_2', note: 'secondary', status: 'ACTIVE', version: 1, createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME, profileIds: [PROFILE_TWO], protected: false },
    ], nextCursor: null, prevCursor: null, total: 2, limit: 250,
  });
}

export function assignedProfilesPage(input: { revision?: number; prompt?: string; captureSession?: string | null; injectSession?: string | null } = {}) {
  const revision = input.revision ?? 7;
  return checked(ProfileSelfServiceAssignedPageSchema, {
    tenantId: TENANT_ID, total: 1, limit: 50, nextCursor: null,
    items: [{
      profileId: PROFILE_ONE, tenantId: TENANT_ID, businessId: 'document-core', businessVersion: '1.0.0',
      profileName: 'default', action: 'extract', endpointSlug: 'extract-invoice', revision,
      connectorBindings: { primary: { connectorId: 'vendor-extract', revision: 3 } },
      inputSchema: { type: 'object', properties: {
        prompt: { type: 'string', title: 'Prompt' },
        pageLimit: { type: 'integer', title: 'Page limit' },
      }, required: ['prompt'] },
      parameters: {
        prompt: { value: input.prompt ?? 'Extract invoice fields.' },
        pageLimit: { value: 20, isLocked: true },
      },
      connectionsOverride: [
        { slug: 'lookup', stepId: 'step-lookup', captureSession: input.captureSession ?? 'auth-session', injectSession: null },
        { slug: 'extract', stepId: 'step-extract', captureSession: null, injectSession: input.injectSession ?? 'auth-session' },
      ],
    }],
  });
}

export function assignedProfileKeysPage() {
  return checked(ProfileSelfServiceAssignedApiKeyPageSchema, {
    tenantId: TENANT_ID, profileId: PROFILE_ONE, total: 1, limit: 50, nextCursor: null,
    items: [{ apiKeyId: KEY_ONE, name: 'profile-one', prefix: 'du_live_assigned', status: 'ACTIVE' }],
  });
}

export function assignedProfileEditResult(revision: number) {
  return checked(ProfileSelfServiceEditResponseSchema, { tenantId: TENANT_ID, profileId: PROFILE_ONE, revision, replayed: false });
}

export function incidentValue(status: 'open' | 'acknowledged' | 'resolved' = 'open', sourceState: 'active' | 'recovered' | 'reconciled' = 'active') {
  return {
    id: INCIDENT_ID, tenantId: TENANT_ID, scope: { kind: 'tenant', tenantId: TENANT_ID },
    source: 'runtime', sourceRef: 'worker-runtime', signalCode: 'WORKER_HEARTBEAT_STALE',
    severity: 'high', status, sourceState, summary: 'Worker heartbeat sample is stale', ownerId: null,
    firstSeenAt: FIXTURE_TIME, lastSeenAt: FIXTURE_TIME, lastSampledAt: FIXTURE_TIME,
    occurrenceCount: 2, stateVersion: status === 'open' ? 1 : status === 'acknowledged' ? 2 : 3,
    thresholdRevision: 'worker-heartbeat-v1', affectedResources: [{ kind: 'replica', ref: 'orchestrator-a', label: 'orchestrator-a' }],
    counters: { missed: 2 }, suppressed: false, acknowledgedAt: status === 'open' ? null : FIXTURE_TIME,
    resolvedAt: status === 'resolved' ? FIXTURE_TIME : null, resolutionEvidenceRef: status === 'resolved' ? 'worker-recovered-proof-1' : null,
  };
}

export function incidentListPage(status: 'open' | 'acknowledged' | 'resolved' = 'open') {
  return checked(IncidentListPageSchema, {
    items: [incidentValue(status)], limit: 50, hasMore: false, sampledAt: FIXTURE_TIME, tenantId: TENANT_ID,
  });
}

export function incidentDetail(status: 'open' | 'acknowledged' | 'resolved' = 'open', recovered = false) {
  const history: unknown[] = [{
    id: INCIDENT_EVENT_ID, kind: 'detected', occurredAt: FIXTURE_TIME, actor: 'worker-runtime',
    summary: 'Heartbeat threshold exceeded', evidenceRef: null, sourceState: 'active', details: { misses: 2 },
  }];
  if (status !== 'open') history.push({
    id: '77777777-7777-4777-8777-777777777773', kind: 'acknowledged', occurredAt: FIXTURE_TIME,
    actor: 'orv14-platform-admin', summary: 'Responder acknowledged the incident', evidenceRef: null, sourceState: 'active', details: null,
  });
  if (recovered) history.push({
    id: INCIDENT_RECOVERY_EVENT_ID, kind: 'source_recovered', occurredAt: FIXTURE_TIME,
    actor: 'worker-runtime', summary: 'Fresh worker heartbeat observed', evidenceRef: 'worker-recovered-proof-1', sourceState: 'recovered', details: null,
  });
  return checked(IncidentDetailSchema, { incident: incidentValue(status, recovered ? 'recovered' : 'active'), history, sampledAt: FIXTURE_TIME });
}

export function maintenanceSuppressions() {
  return checked(MaintenanceSuppressionListSchema, { items: [], sampledAt: FIXTURE_TIME });
}

export function connectorCapabilities() {
  return checked(ConnectorCapabilitiesSchema, {
    management: true, credentialWorkflow: true, test: true, knownConnectorIds: ['vendor-extract'],
  });
}

export function serviceInventory() {
  return checked(ServiceInventorySchema, {
    sampledAt: FIXTURE_TIME, source: ['postgres', 'runtime-heartbeat'], freshness: 'FRESH',
    services: [{ serviceId: 'orchestrator', kind: 'orchestrator', dependencies: [], replicas: [
      { serviceId: 'orchestrator', replicaId: 'orchestrator-a', role: 'orchestrator', businessId: null, businessVersion: null, desiredRevision: 'orv14', observedRevision: 'orv14', state: 'READY', lastSeenAt: FIXTURE_TIME, activeWork: 0, controlRevision: 1, controlState: 'OPEN' },
      { serviceId: 'orchestrator', replicaId: 'orchestrator-b', role: 'orchestrator', businessId: null, businessVersion: null, desiredRevision: 'orv14', observedRevision: null, state: 'UNKNOWN', lastSeenAt: null, activeWork: null, controlRevision: null, controlState: null },
    ] }],
  });
}

export function queueInventory() {
  return checked(QueueInventorySchema, {
    sampledAt: FIXTURE_TIME, source: ['postgres', 'redis'], freshness: 'FRESH', queues: [],
  });
}

export function maintenancePreview() {
  const now = new Date().toISOString();
  return checked(MaintenancePreviewSchema, {
    previewId: 'orv14-backup-preview-1', kind: 'backup', scope: { kind: 'platform' },
    createdAt: now, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), expectedVersion: 'a'.repeat(64),
    retentionRevision: 4, candidateCount: 2, eligibleCount: 1, skippedCount: 0, unknownCount: 1, estimatedBytes: null,
    targets: [
      { itemId: 'backup-candidate-1', itemType: 'backup', eligibility: 'ELIGIBLE', reasonCode: null, estimatedBytes: 4096 },
      { itemId: 'backup-candidate-2', itemType: 'backup', eligibility: 'UNKNOWN', reasonCode: 'SOURCE_UNAVAILABLE', estimatedBytes: null },
    ],
  });
}

export function maintenanceJob() {
  const now = new Date().toISOString();
  return checked(MaintenanceJobSchema, {
    jobId: 'orv14-backup-job-unknown-1', kind: 'backup', state: 'UNKNOWN', scope: { kind: 'platform' },
    createdAt: now, updatedAt: now, totalItems: 2, completedItems: 2, appliedItems: 0, skippedItems: 1,
    failedItems: 0, unknownItems: 1, lastErrorCode: 'ACK_UNKNOWN',
    items: [
      { itemId: 'backup-candidate-1', itemType: 'backup', status: 'SKIPPED', code: 'NOT_SELECTED', evidence: {}, updatedAt: now },
      { itemId: 'backup-candidate-2', itemType: 'backup', status: 'UNKNOWN', code: 'ACK_UNKNOWN', evidence: {}, updatedAt: now },
    ],
  });
}

export async function waitForCall(fixture: ApiFixture, method: string, path: string): Promise<ApiCall> {
  await expect.poll(() => fixture.calls.some((call) => call.method === method && call.path === path)).toBe(true);
  const call = [...fixture.calls].reverse().find((item) => item.method === method && item.path === path);
  if (!call) throw new Error(`expected API call ${method} ${path}`);
  return call;
}

export async function clickLink(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Orchestrator Portal Navigation' }).getByRole('link', { name, exact: true }).click();
}
