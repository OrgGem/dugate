import type { AdminWebSession, SecretCatalogEntryRead } from '../../../apps/admin-web/src/lib/api';
import type { CostAdjustmentHistoryPage, TenantActiveConnectorCatalogPage } from '@du/contracts';
import { buildCostAdjustmentReview, canWriteCostAdjustments, adjustmentHistoryMatchesScope } from '../../../apps/admin-web/src/features/usage/cost-adjustment-state';
import { exactStorageSecretReference, isManagedStorageCredential, storageSecretCatalogQuery } from '../../../apps/admin-web/src/features/settings/storage-secret-catalog';
import { tenantActiveConnectorPageMatches, tenantActiveConnectorQuery } from '../../../apps/admin-web/src/features/settings/tenant-connector-catalog';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ROOT = 'usage-event-123';
const ARTIFACT = '22222222-2222-4222-8222-222222222222';
const SECRET = '33333333-3333-4333-8333-333333333333';

function session(role: AdminWebSession['role'], kind: AdminWebSession['principal']['kind'], tenantId: string | null): AdminWebSession {
  return {
    schemaVersion: '1', plane: 'oidc', role,
    principal: { kind, tenantId },
    scope: kind === 'platform' ? { kind: 'platform' } : tenantId ? { kind: 'tenant', tenantId } : null,
    displayName: 'Admin', localUser: false, csrfToken: 'csrf',
  };
}

describe('ORV14 finance and Settings UI owner behavior', () => {
  test('builds only typed correction or refund review commands and delegates net math to the server', () => {
    const base = {
      tenantId: TENANT,
      rootEventId: ROOT,
      expectedAdjustmentRevision: 4,
      reason: '  Correct invoice allocation  ',
      evidenceArtifactId: ARTIFACT,
    };
    expect(buildCostAdjustmentReview({ ...base, kind: 'correction', amountText: '80000000' })).toEqual({
      ...base, reason: 'Correct invoice allocation', kind: 'correction', targetChargeMicrousd: 80_000_000,
    });
    expect(buildCostAdjustmentReview({ ...base, kind: 'refund', amountText: '30000000' })).toEqual({
      ...base, reason: 'Correct invoice allocation', kind: 'refund', refundMicrousd: 30_000_000,
    });
    expect(buildCostAdjustmentReview({ ...base, kind: 'refund', amountText: '0' })).toBeNull();
    expect(buildCostAdjustmentReview({ ...base, kind: 'correction', amountText: '1.5' })).toBeNull();
    expect(buildCostAdjustmentReview({ ...base, kind: 'correction', amountText: '9007199254740992' })).toBeNull();
    expect(buildCostAdjustmentReview({ ...base, evidenceArtifactId: 'raw-uuid-required', kind: 'correction', amountText: '1' })).toBeNull();
  });

  test('restricts adjustment writes to platform Admin and binds history to the exact tenant and root', () => {
    expect(canWriteCostAdjustments(session('admin', 'platform', null))).toBe(true);
    expect(canWriteCostAdjustments(session('admin', 'tenant_operator', TENANT))).toBe(false);
    expect(canWriteCostAdjustments(session('operator', 'platform', null))).toBe(false);
    const page: CostAdjustmentHistoryPage = {
      tenantId: TENANT, rootEventId: ROOT, adjustmentRevision: 0, headAdjustmentEventId: null,
      eligible: false, blockers: ['ROOT_NOT_FOUND'], initialChargeMicrousd: null, grossChargeMicrousd: null,
      refundedMicrousd: null, netChargeMicrousd: null, originalAttribution: null, items: [], limit: 50, nextCursor: null,
    };
    expect(adjustmentHistoryMatchesScope(page, TENANT, ROOT)).toBe(true);
    expect(adjustmentHistoryMatchesScope(page, 'other-tenant', ROOT)).toBe(false);
  });

  test('keeps Connector search tenant-pinned and pages through the protected catalog', () => {
    expect(tenantActiveConnectorQuery(session('admin', 'platform', null), TENANT, ' gemini ', 'cursor-1')).toEqual({
      tenantId: TENANT, q: 'gemini', cursor: 'cursor-1', limit: 100,
    });
    expect(tenantActiveConnectorQuery(session('admin', 'tenant_operator', TENANT), TENANT, 'openai', null)).toEqual({
      q: 'openai', limit: 100,
    });
    expect(tenantActiveConnectorQuery(session('admin', 'tenant_operator', TENANT), 'other-tenant', '', null)).toBeNull();
    expect(tenantActiveConnectorQuery(session('viewer', 'platform', null), TENANT, '', null)).toBeNull();
    const page: TenantActiveConnectorCatalogPage = {
      tenantId: TENANT, items: [{ tenantId: TENANT, connectorId: 'gemini-primary', revision: 3, adapter: 'gemini',
        provider: 'gemini', model: 'gemini-2.5-flash', credentialConfigured: true, updatedAt: '2026-10-12T00:00:00.000Z' }],
      limit: 100, nextCursor: null,
    };
    expect(tenantActiveConnectorPageMatches(page, TENANT)).toBe(true);
    expect(tenantActiveConnectorPageMatches({ ...page, items: [{ ...page.items[0]!, tenantId: 'other-tenant' }] }, TENANT)).toBe(false);
  });

  test('searches Secret Catalog server-side with tenant, purpose, service and state filters while pinning a revision', () => {
    expect(storageSecretCatalogQuery(TENANT, ' storage ', 'cursor-2')).toEqual({
      tenantId: TENANT, purpose: 'storage.credential', service: 'orchestrator', state: 'ACTIVE',
      limit: '200', q: 'storage', cursor: 'cursor-2',
    });
    const eligible = {
      secretId: SECRET, revision: 7, tenantId: TENANT, purpose: 'storage.credential', state: 'ACTIVE',
      provider: { kind: 'managed_value' }, services: ['orchestrator'],
    } as unknown as SecretCatalogEntryRead;
    expect(isManagedStorageCredential(eligible, TENANT)).toBe(true);
    expect(exactStorageSecretReference(eligible)).toBe(`${SECRET}@7`);
    expect(isManagedStorageCredential(eligible, 'other-tenant')).toBe(false);
    expect(isManagedStorageCredential({ ...eligible, state: 'DISABLED' }, TENANT)).toBe(false);
  });
});
