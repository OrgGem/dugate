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
