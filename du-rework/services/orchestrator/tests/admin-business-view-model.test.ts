/**
 * Unit tests for P6-02 pure Business Registry, Version & Health View Models.
 *
 * Validates:
 * - buildBusinessVersionStatusBadge: table-driven across all 4 BusinessStatus values.
 * - canEnableVersion, canDrainVersion, canRetireVersion: strict transition guards.
 * - resolveWorkerHeartbeat: telemetry decoding, freshness thresholds, degradation, offline.
 * - resolveVersionHealth: operational health indicators ('healthy', 'no-active', 'draining', 'retired').
 * - buildBusinessVersionListView: mapping version rows to display rows with dual array/object view model.
 * - buildVersionTransitionConfirm: confirmation dialog descriptors for enable, drain, and retire actions.
 * - buildBusinessHealthView: aggregate business health across single and multi-version fleets,
 *   including "business chưa có worker" and coexistence draining scenarios.
 *
 * Pure offline tests: Zero database activity, zero Redis activity, zero HTTP I/O, strict TypeScript.
 */

import {
  buildBusinessHealthView,
  buildBusinessVersionListView,
  buildBusinessVersionStatusBadge,
  buildVersionTransitionConfirm,
  canDrainVersion,
  canEnableVersion,
  canRetireVersion,
  resolveVersionHealth,
  resolveWorkerHeartbeat,
  toBusinessVersionDisplayRow,
  type BusinessVersionDisplayRow,
  type BusinessVersionRow,
  type VersionStatusBadge,
  type VersionTransitionAction,
} from '../src/app/admin/business-view-models';
import type { BusinessStatus, WorkerHealth } from '@du/contracts';

describe('P6-02: buildBusinessVersionStatusBadge', () => {
  const cases: Array<{
    state: BusinessStatus;
    expectedBadge: VersionStatusBadge;
    expectedLabel: string;
  }> = [
    { state: 'ENABLED', expectedBadge: 'success', expectedLabel: 'Enabled' },
    { state: 'DRAINING', expectedBadge: 'warning', expectedLabel: 'Draining' },
    { state: 'REGISTERED_DISABLED', expectedBadge: 'neutral', expectedLabel: 'Registered (Disabled)' },
    { state: 'RETIRED', expectedBadge: 'neutral', expectedLabel: 'Retired' },
  ];

  test.each(cases)(
    'maps state $state to badge $expectedBadge and label $expectedLabel',
    ({ state, expectedBadge, expectedLabel }) => {
      const result = buildBusinessVersionStatusBadge(state);
      expect(result.state).toBe(state);
      expect(result.badge).toBe(expectedBadge);
      expect(result.label).toBe(expectedLabel);
    },
  );

  test('handles unknown state gracefully with neutral fallback', () => {
    const result = buildBusinessVersionStatusBadge('ARCHIVED' as BusinessStatus);
    expect(result.badge).toBe('neutral');
    expect(result.label).toBe('ARCHIVED');
  });
});

describe('P6-02: Transition Action Guards (canEnableVersion, canDrainVersion, canRetireVersion)', () => {
  const allStates: BusinessStatus[] = [
    'REGISTERED_DISABLED',
    'ENABLED',
    'DRAINING',
    'RETIRED',
  ];

  describe('canEnableVersion', () => {
    test.each(allStates)('state %s evaluation', (state) => {
      const expected = state === 'REGISTERED_DISABLED';
      expect(canEnableVersion(state)).toBe(expected);
    });

    test('returns false for arbitrary strings', () => {
      expect(canEnableVersion('UNKNOWN')).toBe(false);
      expect(canEnableVersion('')).toBe(false);
    });
  });

  describe('canDrainVersion', () => {
    test.each(allStates)('state %s evaluation', (state) => {
      const expected = state === 'ENABLED';
      expect(canDrainVersion(state)).toBe(expected);
    });

    test('returns false for arbitrary strings', () => {
      expect(canDrainVersion('UNKNOWN')).toBe(false);
      expect(canDrainVersion('')).toBe(false);
    });
  });

  describe('canRetireVersion', () => {
    test.each(allStates)('state %s evaluation', (state) => {
      const expected = state === 'DRAINING';
      expect(canRetireVersion(state)).toBe(expected);
    });

    test('returns false for arbitrary strings', () => {
      expect(canRetireVersion('UNKNOWN')).toBe(false);
      expect(canRetireVersion('')).toBe(false);
    });
  });
});

describe('P6-02: resolveWorkerHeartbeat', () => {
  const fixedNow = 1774300000000; // Fixed deterministic timestamp

  test('preserves explicit WorkerHeartbeatDisplay object', () => {
    const row: BusinessVersionRow = {
      businessId: 'doc-parser',
      version: '1.0.0',
      status: 'ENABLED',
      workerHeartbeat: {
        status: 'online',
        label: 'Custom Online',
        lastHeartbeatAt: '2026-09-23T00:00:00Z',
        workerCount: 5,
      },
    };
    const hb = resolveWorkerHeartbeat(row, fixedNow);
    expect(hb.status).toBe('online');
    expect(hb.label).toBe('Custom Online');
    expect(hb.workerCount).toBe(5);
    expect(hb.lastHeartbeatAt).toBe('2026-09-23T00:00:00Z');
  });

  test.each([
    { input: 'online', expectedStatus: 'online', expectedLabel: 'Online' },
    { input: 'degraded', expectedStatus: 'degraded', expectedLabel: 'Degraded' },
    { input: 'offline', expectedStatus: 'offline', expectedLabel: 'Offline' },
    { input: 'none', expectedStatus: 'none', expectedLabel: 'No workers' },
  ])('resolves string heartbeat "$input"', ({ input, expectedStatus, expectedLabel }) => {
    const row: BusinessVersionRow = {
      businessId: 'doc-parser',
      version: '1.0.0',
      status: 'ENABLED',
      workerHeartbeat: input,
    };
    const hb = resolveWorkerHeartbeat(row, fixedNow);
    expect(hb.status).toBe(expectedStatus);
    expect(hb.label).toBe(expectedLabel);
  });

  test.each([
    { health: 'HEALTHY' as WorkerHealth, expectedStatus: 'online', expectedLabel: 'Online', workers: 1 },
    { health: 'DEGRADED' as WorkerHealth, expectedStatus: 'degraded', expectedLabel: 'Degraded', workers: 1 },
    { health: 'OFFLINE' as WorkerHealth, expectedStatus: 'offline', expectedLabel: 'Offline', workers: 0 },
  ])('maps contract WorkerHealth "$health"', ({ health, expectedStatus, expectedLabel, workers }) => {
    const row: BusinessVersionRow = {
      businessId: 'doc-parser',
      version: '1.0.0',
      status: 'ENABLED',
      workerHealth: health,
    };
    const hb = resolveWorkerHeartbeat(row, fixedNow);
    expect(hb.status).toBe(expectedStatus);
    expect(hb.label).toBe(expectedLabel);
    expect(hb.workerCount).toBe(workers);
  });

  test('identifies zero worker count as none', () => {
    const row: BusinessVersionRow = {
      businessId: 'doc-parser',
      version: '1.0.0',
      status: 'ENABLED',
      workerCount: 0,
    };
    const hb = resolveWorkerHeartbeat(row, fixedNow);
    expect(hb.status).toBe('none');
    expect(hb.label).toBe('No workers');
    expect(hb.workerCount).toBe(0);
  });

  test('calculates heartbeat age thresholds accurately', () => {
    // 30 seconds ago -> online (<= 60s)
    const freshIso = new Date(fixedNow - 30 * 1000).toISOString();
    const freshRow: BusinessVersionRow = {
      businessId: 'doc-parser',
      version: '1.0.0',
      status: 'ENABLED',
      lastHeartbeatAt: freshIso,
    };
    expect(resolveWorkerHeartbeat(freshRow, fixedNow).status).toBe('online');

    // 150 seconds ago -> degraded (60s < t <= 300s)
    const degradedIso = new Date(fixedNow - 150 * 1000).toISOString();
    const degradedRow: BusinessVersionRow = {
      businessId: 'doc-parser',
      version: '1.0.0',
      status: 'ENABLED',
      lastHeartbeatAt: degradedIso,
    };
    expect(resolveWorkerHeartbeat(degradedRow, fixedNow).status).toBe('degraded');

    // 600 seconds ago -> offline (> 300s)
    const deadIso = new Date(fixedNow - 600 * 1000).toISOString();
    const deadRow: BusinessVersionRow = {
      businessId: 'doc-parser',
      version: '1.0.0',
      status: 'ENABLED',
      lastHeartbeatAt: deadIso,
    };
    expect(resolveWorkerHeartbeat(deadRow, fixedNow).status).toBe('offline');
  });

  test('defaults to status "none" when no telemetry is present', () => {
    const row: BusinessVersionRow = {
      businessId: 'doc-parser',
      version: '1.0.0',
      status: 'ENABLED',
    };
    const hb = resolveWorkerHeartbeat(row, fixedNow);
    expect(hb.status).toBe('none');
    expect(hb.label).toBe('No workers');
    expect(hb.workerCount).toBe(0);
  });
});

describe('P6-02: resolveVersionHealth', () => {
  test('returns "retired" for RETIRED status regardless of workers', () => {
    const row: BusinessVersionRow = {
      businessId: 'biz',
      version: '1.0.0',
      status: 'RETIRED',
      workerHealth: 'HEALTHY',
    };
    expect(resolveVersionHealth(row)).toBe('retired');
  });

  test('returns "draining" for DRAINING status', () => {
    const row: BusinessVersionRow = {
      businessId: 'biz',
      version: '1.0.0',
      status: 'DRAINING',
      workerHealth: 'HEALTHY',
    };
    expect(resolveVersionHealth(row)).toBe('draining');
  });

  test('returns "no-active" for REGISTERED_DISABLED status', () => {
    const row: BusinessVersionRow = {
      businessId: 'biz',
      version: '1.0.0',
      status: 'REGISTERED_DISABLED',
    };
    expect(resolveVersionHealth(row)).toBe('no-active');
  });

  test('returns "no-active" for ENABLED when isActive is explicitly false', () => {
    const row: BusinessVersionRow = {
      businessId: 'biz',
      version: '1.0.0',
      status: 'ENABLED',
      isActive: false,
      workerHealth: 'HEALTHY',
    };
    expect(resolveVersionHealth(row)).toBe('no-active');
  });

  test('returns "no-active" for ENABLED when worker is offline or zero', () => {
    const rowWithZeroWorkers: BusinessVersionRow = {
      businessId: 'biz',
      version: '1.0.0',
      status: 'ENABLED',
      workerCount: 0,
    };
    expect(resolveVersionHealth(rowWithZeroWorkers)).toBe('no-active');

    const rowWithOfflineHealth: BusinessVersionRow = {
      businessId: 'biz',
      version: '1.0.0',
      status: 'ENABLED',
      workerHealth: 'OFFLINE',
    };
    expect(resolveVersionHealth(rowWithOfflineHealth)).toBe('no-active');
  });

  test('returns "healthy" for ENABLED with active workers', () => {
    const row: BusinessVersionRow = {
      businessId: 'biz',
      version: '1.0.0',
      status: 'ENABLED',
      workerHealth: 'HEALTHY',
      isActive: true,
    };
    expect(resolveVersionHealth(row)).toBe('healthy');
  });
});

describe('P6-02: toBusinessVersionDisplayRow & buildBusinessVersionListView', () => {
  const versions: BusinessVersionRow[] = [
    {
      businessId: 'test-biz',
      version: '1.0.0',
      status: 'RETIRED',
      registeredAt: '2026-01-01T00:00:00Z',
    },
    {
      businessId: 'test-biz',
      version: '1.1.0',
      status: 'DRAINING',
      workerHealth: 'HEALTHY',
      registeredAt: '2026-02-01T00:00:00Z',
    },
    {
      businessId: 'test-biz',
      version: '2.0.0',
      status: 'ENABLED',
      isActive: true,
      workerHealth: 'HEALTHY',
      registeredAt: '2026-03-01T00:00:00Z',
    },
    {
      businessId: 'test-biz',
      version: '2.1.0-alpha',
      status: 'REGISTERED_DISABLED',
      registeredAt: '2026-04-01T00:00:00Z',
    },
  ];

  test('toBusinessVersionDisplayRow produces a correct display projection', () => {
    const row = toBusinessVersionDisplayRow(versions[2]!);
    expect(row.businessId).toBe('test-biz');
    expect(row.version).toBe('2.0.0');
    expect(row.status).toBe('ENABLED');
    expect(row.statusBadge.badge).toBe('success');
    expect(row.health).toBe('healthy');
    expect(row.healthIndicator).toBe('healthy');
    expect(row.isActive).toBe(true);
    expect(row.workerHeartbeat.status).toBe('online');
    expect(row.canEnable).toBe(false);
    expect(row.canDrain).toBe(true);
    expect(row.canRetire).toBe(false);
    expect(row.registeredAt).toBe('2026-03-01T00:00:00Z');
  });

  test('buildBusinessVersionListView maps rows and provides dual array/object access', () => {
    const listView = buildBusinessVersionListView(versions);

    // Array interface
    expect(Array.isArray(listView)).toBe(true);
    expect(listView).toHaveLength(4);
    expect(listView[0]!.version).toBe('1.0.0');
    expect(listView[0]!.health).toBe('retired');
    expect(listView[1]!.version).toBe('1.1.0');
    expect(listView[1]!.health).toBe('draining');
    expect(listView[2]!.version).toBe('2.0.0');
    expect(listView[2]!.health).toBe('healthy');
    expect(listView[3]!.version).toBe('2.1.0-alpha');
    expect(listView[3]!.health).toBe('no-active');

    // Object interface properties
    expect(listView.total).toBe(4);
    expect(listView.rows).toHaveLength(4);
    expect(listView.activeVersion).toBe('2.0.0');
  });

  test('buildBusinessVersionListView respects explicit activeVersion option', () => {
    const listView = buildBusinessVersionListView(versions, { activeVersion: '1.1.0' });
    expect(listView.activeVersion).toBe('1.1.0');
  });
});

describe('P6-02: buildVersionTransitionConfirm', () => {
  const cases: Array<{
    action: VersionTransitionAction;
    expectedTitle: string;
    expectedVariant: 'default' | 'warning' | 'danger';
    expectedDestructive: boolean;
    expectedConfirmLabel: string;
  }> = [
    {
      action: 'enable',
      expectedTitle: 'Enable version 1.2.3',
      expectedVariant: 'default',
      expectedDestructive: false,
      expectedConfirmLabel: 'Enable',
    },
    {
      action: 'drain',
      expectedTitle: 'Drain version 1.2.3',
      expectedVariant: 'warning',
      expectedDestructive: false,
      expectedConfirmLabel: 'Drain',
    },
    {
      action: 'retire',
      expectedTitle: 'Retire version 1.2.3',
      expectedVariant: 'danger',
      expectedDestructive: true,
      expectedConfirmLabel: 'Retire',
    },
  ];

  test.each(cases)(
    'builds confirm model for action $action',
    ({ action, expectedTitle, expectedVariant, expectedDestructive, expectedConfirmLabel }) => {
      const confirm = buildVersionTransitionConfirm('1.2.3', action);
      expect(confirm.action).toBe(action);
      expect(confirm.version).toBe('1.2.3');
      expect(confirm.title).toBe(expectedTitle);
      expect(confirm.variant).toBe(expectedVariant);
      expect(confirm.destructive).toBe(expectedDestructive);
      expect(confirm.confirmLabel).toBe(expectedConfirmLabel);
      expect(confirm.cancelLabel).toBe('Cancel');
      expect(confirm.impact.length).toBeGreaterThan(10);
      expect(confirm.message).toContain('1.2.3');
    },
  );

  test('supports object target with businessId', () => {
    const confirm = buildVersionTransitionConfirm(
      { businessId: 'doc-verify', version: '2.0.0' },
      'drain',
    );
    expect(confirm.businessId).toBe('doc-verify');
    expect(confirm.version).toBe('2.0.0');
    expect(confirm.action).toBe('drain');
  });

  test('throws on unknown transition action', () => {
    expect(() =>
      buildVersionTransitionConfirm('1.0.0', 'rollback' as unknown as VersionTransitionAction),
    ).toThrow('Unsupported version transition action');
  });
});

describe('P6-02: buildBusinessHealthView', () => {
  test('returns "no-active" with empty version list', () => {
    const health = buildBusinessHealthView([]);
    expect(health.health).toBe('no-active');
    expect(health.healthBadge).toBe('neutral');
    expect(health.totalVersions).toBe(0);
    expect(health.activeVersion).toBeNull();
    expect(health.hasActiveWorkers).toBe(false);
    expect(health.summary).toBe('No registered versions');
  });

  test('returns "retired" when all registered versions are retired', () => {
    const versions: BusinessVersionRow[] = [
      { businessId: 'archive-biz', version: '0.9.0', status: 'RETIRED' },
      { businessId: 'archive-biz', version: '1.0.0', status: 'RETIRED' },
    ];
    const health = buildBusinessHealthView(versions);
    expect(health.health).toBe('retired');
    expect(health.healthBadge).toBe('neutral');
    expect(health.retiredVersions).toBe(2);
    expect(health.summary).toContain('retired');
  });

  test('returns "no-active" when versions are only registered disabled', () => {
    const versions: BusinessVersionRow[] = [
      { businessId: 'biz', version: '1.0.0', status: 'REGISTERED_DISABLED' },
    ];
    const health = buildBusinessHealthView(versions);
    expect(health.health).toBe('no-active');
    expect(health.healthBadge).toBe('neutral');
    expect(health.disabledVersions).toBe(1);
    expect(health.hasActiveWorkers).toBe(false);
  });

  test('returns "draining" when active version is draining and none is enabled', () => {
    const versions: BusinessVersionRow[] = [
      { businessId: 'biz', version: '1.0.0', status: 'DRAINING' },
    ];
    const health = buildBusinessHealthView(versions);
    expect(health.health).toBe('draining');
    expect(health.healthBadge).toBe('warning');
    expect(health.drainingVersions).toBe(1);
    expect(health.summary).toContain('draining');
  });

  test('handles "Business chưa có worker" (enabled version with 0 workers or offline)', () => {
    const versions: BusinessVersionRow[] = [
      {
        businessId: 'biz',
        version: '1.0.0',
        status: 'ENABLED',
        isActive: true,
        workerCount: 0,
      },
    ];
    const health = buildBusinessHealthView(versions);
    expect(health.health).toBe('no-active');
    expect(health.healthBadge).toBe('neutral');
    expect(health.hasActiveWorkers).toBe(false);
    expect(health.summary).toContain('no active workers');
  });

  test('returns "degraded" when active version worker heartbeat is degraded', () => {
    const versions: BusinessVersionRow[] = [
      {
        businessId: 'biz',
        version: '1.0.0',
        status: 'ENABLED',
        isActive: true,
        workerHealth: 'DEGRADED',
      },
    ];
    const health = buildBusinessHealthView(versions);
    expect(health.health).toBe('degraded');
    expect(health.healthBadge).toBe('warning');
    expect(health.hasActiveWorkers).toBe(true);
    expect(health.summary).toContain('degraded');
  });

  test('returns "healthy" for single enabled active version with healthy workers', () => {
    const versions: BusinessVersionRow[] = [
      {
        businessId: 'doc-review',
        version: '1.0.0',
        status: 'ENABLED',
        isActive: true,
        workerHealth: 'HEALTHY',
      },
    ];
    const health = buildBusinessHealthView(versions);
    expect(health.health).toBe('healthy');
    expect(health.healthBadge).toBe('success');
    expect(health.activeVersion).toBe('1.0.0');
    expect(health.hasActiveWorkers).toBe(true);
    expect(health.summary).toBe('Version 1.0.0 healthy');
  });

  test('coexistence: returns "healthy" when v2 is active while v1 is draining', () => {
    const versions: BusinessVersionRow[] = [
      {
        businessId: 'doc-review',
        version: '1.0.0',
        status: 'DRAINING',
        workerHealth: 'HEALTHY',
      },
      {
        businessId: 'doc-review',
        version: '2.0.0',
        status: 'ENABLED',
        isActive: true,
        workerHealth: 'HEALTHY',
      },
    ];
    const health = buildBusinessHealthView(versions);
    expect(health.health).toBe('healthy');
    expect(health.healthBadge).toBe('success');
    expect(health.activeVersion).toBe('2.0.0');
    expect(health.enabledVersions).toBe(1);
    expect(health.drainingVersions).toBe(1);
    expect(health.summary).toContain('healthy');
    expect(health.summary).toContain('1 draining');
  });

  test('accepts BusinessVersionDisplayRow array directly from buildBusinessVersionListView', () => {
    const rawVersions: BusinessVersionRow[] = [
      {
        businessId: 'biz-flow',
        version: '1.0.0',
        status: 'ENABLED',
        workerHealth: 'HEALTHY',
      },
    ];
    const displayList = buildBusinessVersionListView(rawVersions);
    const health = buildBusinessHealthView(displayList);
    expect(health.health).toBe('healthy');
    expect(health.totalVersions).toBe(1);
  });
});

// ===========================================================================
// W-ADM-UX-09-BUSINESS-VIEW-MODEL-NEGATIVE (Turn 344 / Cycle 53)
//
// Negative + boundary tests for the pure business view models. Every
// expectation was MEASURED with a throwaway probe against the real function
// first. Several pin behaviour that is arguably wrong; those are marked
// DEFECT and reported, not fixed (production code is out of scope).
//
// Pure unit file: no DB, no HTTP, no listener, so no port band applies.
// ===========================================================================

const WADMUX09_NOW = 1774300000000;
const WADMUX09_XSS = '<script>alert(1)</script>';

const bvRow = (o: Partial<BusinessVersionRow> = {}): BusinessVersionRow =>
  ({ businessId: 'acme', version: '1.0.0', status: 'ENABLED', ...o }) as BusinessVersionRow;

// ---------------------------------------------------------------------------
// 1. Unknown / corrupt BusinessStatus
// ---------------------------------------------------------------------------

describe('W-ADM-UX-09: a corrupt BusinessStatus degrades in the badge but not in health', () => {
  // The badge uses a switch with a default, so it degrades. Everything
  // measured below is the measured behaviour, not the intended behaviour.
  const corrupt: string[] = ['ARCHIVED', '', 'Enabled', 'ENABLED '];

  test.each(corrupt)('buildBusinessVersionStatusBadge(%p) keeps the raw string as label, badge neutral', (state) => {
    const badge = buildBusinessVersionStatusBadge(state);
    expect(badge.label).toBe(state);
    expect(badge.badge).toBe('neutral');
    expect(badge.state).toBe(state as BusinessStatus);
  });

  test('the four real states are not swallowed by the fallback (control)', () => {
    // Without this control the table above would also pass if every state
    // fell through to the default.
    const cases: Array<[BusinessStatus, VersionStatusBadge, string]> = [
      ['ENABLED', 'success', 'Enabled'],
      ['DRAINING', 'warning', 'Draining'],
      ['REGISTERED_DISABLED', 'neutral', 'Registered (Disabled)'],
      ['RETIRED', 'neutral', 'Retired'],
    ];
    for (const [state, badge, label] of cases) {
      const result = buildBusinessVersionStatusBadge(state);
      expect(result.badge).toBe(badge);
      expect(result.label).toBe(label);
    }
  });

  // DEFECT, and the sharpest one in this packet: resolveVersionHealth tests
  // for RETIRED / DRAINING / REGISTERED_DISABLED and then assumes "ENABLED"
  // for everything else, so a status nobody has ever heard of reads healthy.
  test('resolveVersionHealth treats a corrupt status as HEALTHY', () => {
    expect(resolveVersionHealth(bvRow({ status: 'ARCHIVED' as BusinessStatus }), { nowMs: WADMUX09_NOW })).toBe('healthy');
  });

  test('only an explicit isActive:false pulls a corrupt status back to no-active', () => {
    expect(resolveVersionHealth(bvRow({ status: 'ARCHIVED' as BusinessStatus, isActive: false }), { nowMs: WADMUX09_NOW })).toBe('no-active');
  });

  test('the display row inherits that same healthy verdict, with every gate shut', () => {
    const row = toBusinessVersionDisplayRow(bvRow({ status: 'ARCHIVED' as BusinessStatus }), { nowMs: WADMUX09_NOW });
    expect(row.health).toBe('healthy');
    expect(row.statusBadge.badge).toBe('neutral');
    expect(row.statusBadge.label).toBe('ARCHIVED');
    // isActive defaults to (status === 'ENABLED'), which a corrupt status fails.
    expect(row.isActive).toBe(false);
    expect(row.canEnable).toBe(false);
    expect(row.canDrain).toBe(false);
    expect(row.canRetire).toBe(false);
  });

  test('the transition gates reject a corrupt status (control for the rows above)', () => {
    // The gate/display asymmetry again: a bad state cannot authorise a
    // transition, but it does paint the version green.
    expect(canEnableVersion('ARCHIVED')).toBe(false);
    expect(canDrainVersion('ARCHIVED')).toBe(false);
    expect(canRetireVersion('ARCHIVED')).toBe(false);
  });

  test('health view counters do not reconcile: totalVersions=1 but the four statuses sum to 0', () => {
    const health = buildBusinessHealthView([bvRow({ status: 'ARCHIVED' as BusinessStatus, version: '9' })], null);
    expect(health.totalVersions).toBe(1);
    const sum =
      health.enabledVersions + health.drainingVersions + health.retiredVersions + health.disabledVersions;
    expect(sum).toBe(0);
    expect(health.health).toBe('no-active');
  });

  test('a corrupt status is counted in no bucket but still in the total', () => {
    const health = buildBusinessHealthView(
      [bvRow({ status: 'ENABLED', version: '1' }), bvRow({ status: 'ARCHIVED' as BusinessStatus, version: '2' })],
      null,
    );
    expect(health.totalVersions).toBe(2);
    expect(health.enabledVersions).toBe(1);
    expect(health.drainingVersions).toBe(0);
    expect(health.retiredVersions).toBe(0);
    expect(health.disabledVersions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Hostile HTML in businessId / version
// ---------------------------------------------------------------------------

describe('W-ADM-UX-09: businessId and version are interpolated unescaped', () => {
  // Same division of labour as the other view models: the renderer escapes,
  // the mapper does not. These tests pin that the mapper contributes nothing,
  // so the renderer really is the only layer between a hostile id and the DOM.
  test('a hostile status string becomes the badge label verbatim', () => {
    const badge = buildBusinessVersionStatusBadge(WADMUX09_XSS);
    expect(badge.label).toBe(WADMUX09_XSS);
    expect(badge.badge).toBe('neutral');
  });

  test('a hostile businessId and version pass straight into the display row', () => {
    const row = toBusinessVersionDisplayRow(bvRow({ businessId: WADMUX09_XSS, version: WADMUX09_XSS }), {
      nowMs: WADMUX09_NOW,
    });
    expect(row.businessId).toBe(WADMUX09_XSS);
    expect(row.version).toBe(WADMUX09_XSS);
  });

  test('the transition confirm interpolates a hostile version into title and message', () => {
    const confirm = buildVersionTransitionConfirm(WADMUX09_XSS, 'enable');
    expect(confirm.title).toBe('Enable version ' + WADMUX09_XSS);
    expect(confirm.message).toBe('Are you sure you want to enable version ' + WADMUX09_XSS + '?');
  });

  test('the object form carries a hostile businessId and version too', () => {
    const confirm = buildVersionTransitionConfirm({ businessId: WADMUX09_XSS, version: WADMUX09_XSS }, 'retire');
    expect(confirm.businessId).toBe(WADMUX09_XSS);
    expect(confirm.title).toBe('Retire version ' + WADMUX09_XSS);
    expect(confirm.destructive).toBe(true);
  });

  test('the health summary interpolates a hostile version', () => {
    const health = buildBusinessHealthView([bvRow({ businessId: WADMUX09_XSS, version: WADMUX09_XSS })], null);
    expect(health.businessId).toBe(WADMUX09_XSS);
    expect(health.summary).toContain(WADMUX09_XSS);
  });

  test('a hostile version is interpolated into the queue field as well', () => {
    const row = toBusinessVersionDisplayRow(bvRow({ queue: WADMUX09_XSS }), { nowMs: WADMUX09_NOW });
    expect(row.queue).toBe(WADMUX09_XSS);
  });

  test('the three declared actions build, an undeclared one throws', () => {
    // The one place this module refuses rather than degrades. The action
    // union has three members, so this only fires on a cast value.
    for (const action of ['enable', 'drain', 'retire'] as const) {
      expect(buildVersionTransitionConfirm('1.0.0', action).action).toBe(action);
    }
    expect(() => buildVersionTransitionConfirm('1.0.0', 'destroy' as never)).toThrow(
      'Unsupported version transition action: destroy',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Heartbeat timestamp boundaries
// ---------------------------------------------------------------------------

describe('W-ADM-UX-09: heartbeat freshness thresholds and their boundaries', () => {
  const at = (offsetSeconds: number): string => new Date(WADMUX09_NOW - offsetSeconds * 1000).toISOString();
  const beat = (lastHeartbeatAt: string, nowMs: number = WADMUX09_NOW) =>
    resolveWorkerHeartbeat(bvRow({ lastHeartbeatAt }), nowMs);

  test('exactly 60s old is still online, 61s is degraded', () => {
    expect(beat(at(60)).status).toBe('online');
    expect(beat(at(61)).status).toBe('degraded');
  });

  test('exactly 300s old is still degraded, 301s is offline', () => {
    expect(beat(at(300)).status).toBe('degraded');
    expect(beat(at(301)).status).toBe('offline');
  });

  test('a heartbeat from the FUTURE reads as online, not as corrupt', () => {
    // Math.max(0, ...) clamps the age, so a clock-skewed future timestamp
    // looks maximally fresh rather than being rejected.
    const future = new Date(WADMUX09_NOW + 86400000).toISOString();
    const result = beat(future);
    expect(result.status).toBe('online');
    expect(result.lastHeartbeatAt).toBe(future);
  });

  test('a heartbeat from a day ago is offline', () => {
    expect(beat(at(86400)).status).toBe('offline');
  });

  test('a pre-1970 timestamp is offline, not rejected as garbage', () => {
    const result = beat('1969-12-31T23:59:59.000Z');
    expect(result.status).toBe('offline');
    expect(result.lastHeartbeatAt).toBe('1969-12-31T23:59:59.000Z');
  });

  // DEFECT: an unparseable timestamp is silently dropped, and the display
  // then reports lastHeartbeatAt: null — the corruption is invisible.
  test('an unparseable timestamp is dropped and the view reports null', () => {
    const result = beat('garbage');
    expect(result.status).toBe('none');
    expect(result.lastHeartbeatAt).toBeNull();
    expect(result.workerCount).toBe(0);
  });

  test('a rolled-over calendar date keeps the ORIGINAL invalid string in the view', () => {
    // Date.parse rolls 2026-02-30 to 2026-03-02, so the age maths works, but
    // the view still hands the renderer a string the calendar rejects.
    const result = beat('2026-02-30T00:00:00.000Z');
    expect(result.status).toBe('offline');
    expect(result.lastHeartbeatAt).toBe('2026-02-30T00:00:00.000Z');
  });

  // DEFECT: a NaN clock makes every comparison false, so the age falls
  // through to the offline branch - a bad clock declares the fleet down.
  test('a NaN nowMs declares the worker offline', () => {
    const result = beat(new Date(WADMUX09_NOW).toISOString(), NaN);
    expect(result.status).toBe('offline');
    expect(result.workerCount).toBe(0);
  });

  test('a null or absent timestamp yields no workers, not an error', () => {
    expect(resolveWorkerHeartbeat(bvRow({ lastHeartbeatAt: null }), WADMUX09_NOW).status).toBe('none');
    expect(resolveWorkerHeartbeat(bvRow(), WADMUX09_NOW).status).toBe('none');
  });

  test.each([-5, 0, NaN])('a workerCount of %p is normalised to zero workers', (workerCount) => {
    const result = resolveWorkerHeartbeat(bvRow({ workerCount }), WADMUX09_NOW);
    expect(result.status).toBe('none');
    expect(result.workerCount).toBe(0);
  });

  test('a fresh heartbeat is online (control for the boundary rows)', () => {
    const result = beat(at(0));
    expect(result.status).toBe('online');
    expect(result.workerCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Conflicting activeVersion states
// ---------------------------------------------------------------------------

describe('W-ADM-UX-09: conflicting active-version signals are resolved by array order', () => {
  // DEFECT: both find() calls take the FIRST match, so an isActive flag on a
  // retired row outranks a genuinely enabled row further down the list.
  test('a retired row flagged isActive wins over an enabled row', () => {
    const view = buildBusinessVersionListView(
      [bvRow({ version: 'a', isActive: true, status: 'RETIRED' }), bvRow({ version: 'b', status: 'ENABLED' })],
      { nowMs: WADMUX09_NOW },
    );
    expect(view.activeVersion).toBe('a');
  });

  test('two rows both report isActive=true after that conflict resolves', () => {
    // b has no explicit isActive, so it defaults to (status === 'ENABLED') —
    // the list ends up with two "active" rows and one activeVersion.
    const view = buildBusinessVersionListView(
      [bvRow({ version: 'a', isActive: true, status: 'RETIRED' }), bvRow({ version: 'b', status: 'ENABLED' })],
      { nowMs: WADMUX09_NOW },
    );
    const active = view.rows.filter((r) => r.isActive).map((r) => r.version);
    expect(active).toEqual(['a', 'b']);
  });

  test('when two rows are explicitly active, the first wins', () => {
    const view = buildBusinessVersionListView(
      [bvRow({ version: 'x', isActive: true }), bvRow({ version: 'y', isActive: true })],
      { nowMs: WADMUX09_NOW },
    );
    expect(view.activeVersion).toBe('x');
  });

  test('an activeVersion naming a version that is not in the list is returned verbatim', () => {
    // The option short-circuits the fallback, so a ghost name is echoed back
    // with no check that such a version exists.
    const view = buildBusinessVersionListView([bvRow({ version: 'b' })], {
      activeVersion: 'ghost',
      nowMs: WADMUX09_NOW,
    });
    expect(view.activeVersion).toBe('ghost');
    expect(view.total).toBe(1);
  });

  test('an empty-string activeVersion is echoed as empty string, not normalised to null', () => {
    const view = buildBusinessVersionListView([bvRow({ version: 'b' })], {
      activeVersion: '',
      nowMs: WADMUX09_NOW,
    });
    expect(view.activeVersion).toBe('');
  });

  test('a null activeVersion falls back to the isActive/enabled search', () => {
    // Contrast with the empty string above: the fallback only runs when the
    // option is undefined, so null and '' take different paths.
    const view = buildBusinessVersionListView([bvRow({ version: 'b', status: 'ENABLED' })], {
      activeVersion: null as never,
      nowMs: WADMUX09_NOW,
    });
    expect(view.activeVersion).toBe('b');
  });

  test('a disabled row can be both isActive and canEnable at the same time', () => {
    // The row claims to be the active version while also offering to enable it.
    const row = toBusinessVersionDisplayRow(
      bvRow({ isActive: true, status: 'REGISTERED_DISABLED' }),
      { nowMs: WADMUX09_NOW },
    );
    expect(row.isActive).toBe(true);
    expect(row.canEnable).toBe(true);
    expect(row.health).toBe('no-active');
  });

  test('a ghost activeVersion still yields a healthy business view', () => {
    // The active row cannot be found, so hasActiveWorkers falls back to
    // (enabledVersions > 0) and the business is reported healthy.
    const health = buildBusinessHealthView([bvRow({ version: 'b', status: 'ENABLED' })], 'ghost');
    expect(health.activeVersion).toBe('ghost');
    expect(health.hasActiveWorkers).toBe(true);
    expect(health.health).toBe('healthy');
  });

  test('a null activeVersion with a retired-first list resolves to the retired row', () => {
    const health = buildBusinessHealthView(
      [bvRow({ version: 'a', isActive: true, status: 'RETIRED' }), bvRow({ version: 'b', status: 'ENABLED' })],
      null,
    );
    expect(health.activeVersion).toBe('a');
    expect(health.hasActiveWorkers).toBe(false);
    expect(health.health).toBe('no-active');
  });

  test('an empty version list is a clean no-active (control)', () => {
    const view = buildBusinessVersionListView([], { nowMs: WADMUX09_NOW });
    expect(view.total).toBe(0);
    expect(view.activeVersion).toBeNull();
    expect(view.length).toBe(0);
  });
});

