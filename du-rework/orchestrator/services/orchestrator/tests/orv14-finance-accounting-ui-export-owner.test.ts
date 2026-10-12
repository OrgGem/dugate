import { CostAdjustmentHistoryPageSchema } from '@du/contracts';
import {
  buildCostAdjustmentHistoryCsv,
  buildUsageEventsCsv,
  parseAdminUsageEventPage,
} from '../../../apps/admin-web/src/features/usage/state';
import { classifyCostAdjustmentFailure } from '../../../apps/admin-web/src/features/usage/cost-adjustment-state';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADJUSTMENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PREVIOUS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ARTIFACT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GENERATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ACTOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const EVENT = {
  eventId: 'usage-event-1',
  operationId: OPERATION,
  taskId: 'task-1',
  invocationId: 'invoke-1',
  provider: 'provider-x',
  model: 'model-y',
  units: { inputTokens: 10, outputTokens: 2, pages: 1 },
  costMicrousd: 100,
  costStatus: 'measured',
  measurement: 'measured',
  occurredAt: '2026-10-10T10:00:00.000Z',
  receivedAt: '2026-10-10T10:00:03.000Z',
};

const PAGE = {
  tenantId: TENANT,
  events: [EVENT],
  limit: 25,
  hasMore: false,
  skippedInvalidEvents: 0,
  timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' },
};

describe('ORV14 financial accounting Usage UI/export owner regression', () => {
  test('classifies typed adjustment failures before generic HTTP conflict handling', () => {
    expect(classifyCostAdjustmentFailure(409, 'BACKUP_EFFECT_FENCE_ACTIVE')).toBe('maintenance-hold');
    expect(classifyCostAdjustmentFailure(409, 'COST_ADJUSTMENT_CAS_CONFLICT')).toBe('head-conflict');
    expect(classifyCostAdjustmentFailure(409, 'IDEMPOTENCY_CONFLICT')).toBe('idempotency-conflict');
    expect(classifyCostAdjustmentFailure(503, 'SERVICE_UNAVAILABLE')).toBe('unknown-acknowledgement');
    expect(classifyCostAdjustmentFailure(503, 'COST_ADJUSTMENT_CAS_CONFLICT')).toBe('unknown-acknowledgement');
    expect(classifyCostAdjustmentFailure(0, undefined)).toBe('unknown-acknowledgement');
    expect(classifyCostAdjustmentFailure(409, 'UNCLASSIFIED_CONFLICT')).toBe('other');
  });

  test('consumes server net amounts exactly and leaves the immutable initial charge intact', () => {
    const accounting = {
      rootEventId: EVENT.eventId,
      initialChargeMicrousd: 100,
      grossChargeMicrousd: 80,
      refundedMicrousd: 30,
      netChargeMicrousd: 50,
      adjustmentRevision: 2,
      headAdjustmentEventId: ADJUSTMENT,
      semantics: 'initial-charge-plus-direct-root-adjustments-v1',
    };
    const parsed = parseAdminUsageEventPage({
      ...PAGE,
      events: [{ ...EVENT, financialAccounting: accounting }],
    }, TENANT);

    expect(parsed?.events[0]?.costMicrousd).toBe(100);
    expect(parsed?.events[0]?.financialAccounting).toEqual(accounting);
    expect(parseAdminUsageEventPage({
      ...PAGE,
      events: [{ ...EVENT, financialAccounting: { ...accounting, initialChargeMicrousd: 99 } }],
    }, TENANT)).toBeNull();
    expect(parseAdminUsageEventPage({
      ...PAGE,
      events: [{ ...EVENT, financialAccounting: { ...accounting, rootEventId: 'another-root' } }],
    }, TENANT)).toBeNull();
  });

  test('legacy event pages keep accounting nullable and CSV exports only exact page fields', () => {
    const parsed = parseAdminUsageEventPage(PAGE, TENANT);
    expect(parsed?.events[0]?.financialAccounting).toBeNull();
    expect(parsed?.events[0]?.costMicrousd).toBe(100);

    const accounted = parseAdminUsageEventPage({
      ...PAGE,
      events: [
        { ...EVENT, financialAccounting: {
          rootEventId: EVENT.eventId,
          initialChargeMicrousd: 100,
          grossChargeMicrousd: 80,
          refundedMicrousd: 30,
          netChargeMicrousd: 50,
          adjustmentRevision: 2,
          headAdjustmentEventId: ADJUSTMENT,
          semantics: 'initial-charge-plus-direct-root-adjustments-v1',
        } },
      ],
    }, TENANT);
    expect(accounted).not.toBeNull();
    const csv = buildUsageEventsCsv(accounted!.events, TENANT);
    expect(csv).toContain('financial_initial_charge_microusd');
    expect(csv).toContain('financial_net_charge_microusd');
    expect(csv).toContain('initial-charge-plus-direct-root-adjustments-v1');
    expect(csv).toContain('"usage-event-1","100","80","30","50","2"');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2);
  });

  test('history CSV contains only the bounded server page and marks incomplete proof without upgrading it', () => {
    const page = CostAdjustmentHistoryPageSchema.parse({
      tenantId: TENANT,
      rootEventId: EVENT.eventId,
      adjustmentRevision: 2,
      headAdjustmentEventId: ADJUSTMENT,
      eligible: false,
      blockers: ['EVIDENCE_PIN_INCOMPLETE'],
      initialChargeMicrousd: 100,
      grossChargeMicrousd: 80,
      refundedMicrousd: 30,
      netChargeMicrousd: 50,
      originalAttribution: null,
      items: [{
        adjustmentEventId: ADJUSTMENT,
        rootEventId: EVENT.eventId,
        adjustmentRevision: 2,
        previousAdjustmentEventId: PREVIOUS,
        kind: 'refund',
        targetChargeMicrousd: null,
        refundMicrousd: 30,
        initialChargeMicrousd: 100,
        grossChargeMicrousd: 80,
        refundedMicrousd: 30,
        netChargeMicrousd: 50,
        effectiveAt: '2026-10-10T10:00:00.000Z',
        quotaWindowPins: [],
        recordedAt: '2026-10-11T12:30:00.000Z',
        evidenceArtifactId: ARTIFACT,
        evidenceStorageGenerationId: GENERATION,
        evidenceSizeBytes: 12,
        evidenceSha256: DIGEST,
        evidenceObjectSizeBytes: null,
        evidenceObjectSha256: null,
        evidenceObjectProofComplete: false,
        evidenceObjectVersionId: 'object-v1',
        evidenceSidecarSizeBytes: 20,
        evidenceSidecarVersionId: 'sidecar-v1',
        evidenceSidecarSha256: DIGEST,
        authority: 'platform-admin-approved',
        actorPrincipalId: ACTOR,
        actorKind: 'oidc-admin',
        reason: '=HYPERLINK("https://example.invalid","review")',
      }],
      limit: 1,
      nextCursor: 'opaque-next-page-cursor',
    });

    const csv = buildCostAdjustmentHistoryCsv(page);
    expect(csv).toContain('adjustment_revision_head');
    expect(csv).toContain('effective_at_original_event_utc');
    expect(csv).toContain('recorded_at_utc');
    expect(csv).toContain('evidence_object_proof_complete');
    expect(csv).toContain('"refund"');
    expect(csv).toContain('"50"');
    expect(csv).toContain('"incomplete"');
    expect(csv).toContain("'=HYPERLINK(");
    expect(csv).not.toContain('opaque-next-page-cursor');
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2);
  });
});
