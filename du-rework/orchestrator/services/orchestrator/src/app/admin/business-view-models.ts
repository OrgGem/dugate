/**
 * Pure Business Registry, Version & Health View Models (P6-02 headless foundation).
 *
 * Scope: Pure functions mapping domain/wire business version rows and heartbeat telemetry
 * into UI-ready view models, transition action guards, confirmation modal descriptors,
 * and aggregated business health indicators.
 *
 * Pure and offline: Zero DB activity, zero Redis activity, zero HTTP I/O,
 * strict TypeScript with zero `any`.
 */

import type { BusinessStatus, WorkerHealth } from '@du/contracts';

// ---------------------------------------------------------------------------
// View model types
// ---------------------------------------------------------------------------

/** Badge severity for version status and health indicators. */
export type VersionStatusBadge = 'success' | 'warning' | 'error' | 'neutral' | 'info';

/** Display-safe version status badge representation. */
export interface BusinessVersionStatusBadge {
  state: BusinessStatus;
  label: string;
  badge: VersionStatusBadge;
}

/** Discrete operational health indicators for an individual business version. */
export type VersionHealthIndicator = 'healthy' | 'no-active' | 'draining' | 'retired';

/** Normalized worker heartbeat state. */
export type WorkerHeartbeatState = 'online' | 'degraded' | 'offline' | 'none';

/** Display projection of worker heartbeat telemetry. */
export interface WorkerHeartbeatDisplay {
  status: WorkerHeartbeatState;
  label: string;
  lastHeartbeatAt: string | null;
  workerCount: number;
}

/** Input representation of a business version row (from registry/wire/db projection). */
export interface BusinessVersionRow {
  businessId: string;
  version: string;
  status: BusinessStatus;
  isActive?: boolean;
  registeredAt?: string;
  createdAt?: string;
  digest?: string;
  queue?: string;
  lastHeartbeatAt?: string | null;
  workerHealth?: WorkerHealth | string | null;
  workerCount?: number;
  workerHeartbeat?: WorkerHeartbeatState | WorkerHeartbeatDisplay | string;
}

/** Display row for the Business Versions list view table. */
export interface BusinessVersionDisplayRow {
  businessId: string;
  version: string;
  status: BusinessStatus;
  statusBadge: BusinessVersionStatusBadge;
  health: VersionHealthIndicator;
  healthIndicator: VersionHealthIndicator;
  isActive: boolean;
  workerHeartbeat: WorkerHeartbeatDisplay;
  canEnable: boolean;
  canDrain: boolean;
  canRetire: boolean;
  registeredAt: string;
  /**
   * W47-C2 (B): dispatch queue carried from `business_versions.queue`
   * through the live JSON route. Optional — offline fixtures and older
   * rows predate it; the renderer shows an em-dash when absent.
   */
  queue?: string;
}

/** Composite list view representing all versions of a business. */
export interface BusinessVersionListView extends Array<BusinessVersionDisplayRow> {
  rows: BusinessVersionDisplayRow[];
  total: number;
  activeVersion: string | null;
}

/** Supported version lifecycle transition actions. */
export type VersionTransitionAction = 'enable' | 'drain' | 'retire';

/** Confirmation modal descriptor for version lifecycle transitions. */
export interface VersionTransitionConfirmModel {
  action: VersionTransitionAction;
  version: string;
  businessId?: string;
  title: string;
  message: string;
  impact: string;
  confirmLabel: string;
  cancelLabel: string;
  variant: 'default' | 'warning' | 'danger';
  destructive: boolean;
}

/** Aggregate health classification for an overall business. */
export type OverallBusinessHealth = 'healthy' | 'degraded' | 'no-active' | 'draining' | 'retired';

/** Summary view model of overall business health across all registered versions. */
export interface BusinessHealthView {
  businessId: string;
  health: OverallBusinessHealth;
  healthBadge: VersionStatusBadge;
  activeVersion: string | null;
  totalVersions: number;
  enabledVersions: number;
  drainingVersions: number;
  retiredVersions: number;
  disabledVersions: number;
  hasActiveWorkers: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Badge and transition guards
// ---------------------------------------------------------------------------

/**
 * Builds display badge for business version lifecycle states.
 * - ENABLED -> success
 * - DRAINING -> warning
 * - REGISTERED_DISABLED -> neutral
 * - RETIRED -> neutral
 */
export function buildBusinessVersionStatusBadge(
  state: BusinessStatus | string,
): BusinessVersionStatusBadge {
  switch (state) {
    case 'ENABLED':
      return { state: 'ENABLED', label: 'Enabled', badge: 'success' };
    case 'DRAINING':
      return { state: 'DRAINING', label: 'Draining', badge: 'warning' };
    case 'REGISTERED_DISABLED':
      return { state: 'REGISTERED_DISABLED', label: 'Registered (Disabled)', badge: 'neutral' };
    case 'RETIRED':
      return { state: 'RETIRED', label: 'Retired', badge: 'neutral' };
    default:
      return { state: state as BusinessStatus, label: String(state), badge: 'neutral' };
  }
}

/**
 * Returns true if the version state permits enabling.
 * Pure guard: only REGISTERED_DISABLED versions may be enabled.
 */
export function canEnableVersion(state: BusinessStatus | string): boolean {
  return state === 'REGISTERED_DISABLED';
}

/**
 * Returns true if the version state permits draining.
 * Pure guard: only ENABLED versions may be drained.
 */
export function canDrainVersion(state: BusinessStatus | string): boolean {
  return state === 'ENABLED';
}

/**
 * Returns true if the version state permits retiring.
 * Pure guard: only DRAINING versions may be retired.
 */
export function canRetireVersion(state: BusinessStatus | string): boolean {
  return state === 'DRAINING';
}

// ---------------------------------------------------------------------------
// Worker heartbeat & version health resolution
// ---------------------------------------------------------------------------

const DEFAULT_HEARTBEAT_THRESHOLD_SECONDS = 60;
const DEGRADED_HEARTBEAT_THRESHOLD_SECONDS = 300;

function formatHeartbeatLabel(status: WorkerHeartbeatState): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'degraded':
      return 'Degraded';
    case 'offline':
      return 'Offline';
    case 'none':
      return 'No workers';
  }
}

/**
 * Resolves worker heartbeat status from raw heartbeat telemetry or health tags.
 */
export function resolveWorkerHeartbeat(
  row: BusinessVersionRow,
  nowMs: number = Date.now(),
): WorkerHeartbeatDisplay {
  // 1. Explicit WorkerHeartbeatDisplay object
  if (typeof row.workerHeartbeat === 'object' && row.workerHeartbeat !== null) {
    return {
      status: row.workerHeartbeat.status,
      label: row.workerHeartbeat.label ?? formatHeartbeatLabel(row.workerHeartbeat.status),
      lastHeartbeatAt: row.workerHeartbeat.lastHeartbeatAt ?? row.lastHeartbeatAt ?? null,
      workerCount:
        row.workerHeartbeat.workerCount ??
        row.workerCount ??
        (row.workerHeartbeat.status === 'offline' || row.workerHeartbeat.status === 'none' ? 0 : 1),
    };
  }

  // 2. String heartbeat status
  if (typeof row.workerHeartbeat === 'string') {
    const s = row.workerHeartbeat.toLowerCase() as WorkerHeartbeatState;
    if (s === 'online' || s === 'degraded' || s === 'offline' || s === 'none') {
      return {
        status: s,
        label: formatHeartbeatLabel(s),
        lastHeartbeatAt: row.lastHeartbeatAt ?? null,
        workerCount: row.workerCount ?? (s === 'offline' || s === 'none' ? 0 : 1),
      };
    }
  }

  // 3. Contract WorkerHealth ('HEALTHY' | 'DEGRADED' | 'OFFLINE')
  if (row.workerHealth) {
    switch (row.workerHealth) {
      case 'HEALTHY':
        return {
          status: 'online',
          label: 'Online',
          lastHeartbeatAt: row.lastHeartbeatAt ?? null,
          workerCount: row.workerCount ?? 1,
        };
      case 'DEGRADED':
        return {
          status: 'degraded',
          label: 'Degraded',
          lastHeartbeatAt: row.lastHeartbeatAt ?? null,
          workerCount: row.workerCount ?? 1,
        };
      case 'OFFLINE':
        return {
          status: 'offline',
          label: 'Offline',
          lastHeartbeatAt: row.lastHeartbeatAt ?? null,
          workerCount: row.workerCount ?? 0,
        };
    }
  }

  // 4. Worker count zero
  if (row.workerCount !== undefined && row.workerCount <= 0) {
    return {
      status: 'none',
      label: 'No workers',
      lastHeartbeatAt: row.lastHeartbeatAt ?? null,
      workerCount: 0,
    };
  }

  // 5. Last heartbeat timestamp calculation
  if (row.lastHeartbeatAt) {
    const parsed = Date.parse(row.lastHeartbeatAt);
    if (!Number.isNaN(parsed)) {
      const ageSeconds = Math.max(0, (nowMs - parsed) / 1000);
      if (ageSeconds <= DEFAULT_HEARTBEAT_THRESHOLD_SECONDS) {
        return {
          status: 'online',
          label: 'Online',
          lastHeartbeatAt: row.lastHeartbeatAt,
          workerCount: row.workerCount ?? 1,
        };
      }
      if (ageSeconds <= DEGRADED_HEARTBEAT_THRESHOLD_SECONDS) {
        return {
          status: 'degraded',
          label: 'Degraded',
          lastHeartbeatAt: row.lastHeartbeatAt,
          workerCount: row.workerCount ?? 1,
        };
      }
      return {
        status: 'offline',
        label: 'Offline',
        lastHeartbeatAt: row.lastHeartbeatAt,
        workerCount: row.workerCount ?? 0,
      };
    }
  }

  // 6. Positive worker count without timestamp
  if (row.workerCount !== undefined && row.workerCount > 0) {
    return {
      status: 'online',
      label: 'Online',
      lastHeartbeatAt: null,
      workerCount: row.workerCount,
    };
  }

  // 7. Default: no workers
  return {
    status: 'none',
    label: 'No workers',
    lastHeartbeatAt: null,
    workerCount: 0,
  };
}

/**
 * Resolves operational health indicator for a single version:
 * - RETIRED -> 'retired'
 * - DRAINING -> 'draining'
 * - REGISTERED_DISABLED -> 'no-active'
 * - ENABLED:
 *   - isActive === false -> 'no-active'
 *   - offline / no workers -> 'no-active'
 *   - otherwise -> 'healthy'
 */
export function resolveVersionHealth(
  row: BusinessVersionRow,
  options?: { nowMs?: number },
): VersionHealthIndicator {
  if (row.status === 'RETIRED') {
    return 'retired';
  }
  if (row.status === 'DRAINING') {
    return 'draining';
  }
  if (row.status === 'REGISTERED_DISABLED') {
    return 'no-active';
  }

  // status === 'ENABLED'
  if (row.isActive === false) {
    return 'no-active';
  }

  const hb = resolveWorkerHeartbeat(row, options?.nowMs);
  if (hb.status === 'offline' || hb.status === 'none') {
    if (
      row.workerCount !== undefined ||
      row.workerHealth !== undefined ||
      row.workerHeartbeat !== undefined ||
      row.lastHeartbeatAt !== undefined
    ) {
      return 'no-active';
    }
  }

  return 'healthy';
}

/**
 * Map a single BusinessVersionRow to a display row.
 */
export function toBusinessVersionDisplayRow(
  row: BusinessVersionRow,
  options?: { nowMs?: number },
): BusinessVersionDisplayRow {
  const statusBadge = buildBusinessVersionStatusBadge(row.status);
  const workerHeartbeat = resolveWorkerHeartbeat(row, options?.nowMs);
  const health = resolveVersionHealth(row, options);

  return {
    businessId: row.businessId,
    version: row.version,
    status: row.status,
    statusBadge,
    health,
    healthIndicator: health,
    isActive: row.isActive ?? (row.status === 'ENABLED'),
    workerHeartbeat,
    canEnable: canEnableVersion(row.status),
    canDrain: canDrainVersion(row.status),
    canRetire: canRetireVersion(row.status),
    registeredAt: row.registeredAt ?? row.createdAt ?? '',
    // W47-C2 (B): carry the dispatch queue so the pane can show it.
    // Undefined passes through — the renderer degrades to an em-dash.
    queue: row.queue,
  };
}

/**
 * Build Business Version List View.
 * Maps version rows to display rows with state badge, health indicator, and worker heartbeat.
 */
export function buildBusinessVersionListView(
  versions: readonly BusinessVersionRow[],
  options?: { activeVersion?: string; nowMs?: number },
): BusinessVersionListView {
  const rows = versions.map((v) => toBusinessVersionDisplayRow(v, options));
  const activeRow =
    versions.find(
      (v) =>
        v.isActive === true ||
        (options?.activeVersion !== undefined && v.version === options.activeVersion),
    ) ?? versions.find((v) => v.status === 'ENABLED');
  const activeVersion = options?.activeVersion ?? activeRow?.version ?? null;

  const result = Object.assign([...rows], {
    rows,
    total: rows.length,
    activeVersion,
  }) as BusinessVersionListView;

  return result;
}

// ---------------------------------------------------------------------------
// Transition confirmation models
// ---------------------------------------------------------------------------

/**
 * Builds confirmation modal descriptor for version lifecycle transitions (enable/drain/retire).
 */
export function buildVersionTransitionConfirm(
  versionInput: string | { businessId?: string; version: string },
  action: VersionTransitionAction,
): VersionTransitionConfirmModel {
  const version = typeof versionInput === 'string' ? versionInput : versionInput.version;
  const businessId = typeof versionInput === 'object' ? versionInput.businessId : undefined;

  switch (action) {
    case 'enable':
      return {
        action: 'enable',
        version,
        businessId,
        title: `Enable version ${version}`,
        message: `Are you sure you want to enable version ${version}?`,
        impact: 'New operations will be dispatched to this version queue.',
        confirmLabel: 'Enable',
        cancelLabel: 'Cancel',
        variant: 'default',
        destructive: false,
      };

    case 'drain':
      return {
        action: 'drain',
        version,
        businessId,
        title: `Drain version ${version}`,
        message: `Are you sure you want to drain version ${version}?`,
        impact:
          'New submissions will be stopped while in-flight operations continue to completion.',
        confirmLabel: 'Drain',
        cancelLabel: 'Cancel',
        variant: 'warning',
        destructive: false,
      };

    case 'retire':
      return {
        action: 'retire',
        version,
        businessId,
        title: `Retire version ${version}`,
        message: `Are you sure you want to retire version ${version}?`,
        impact:
          'Version will be permanently retired. No active operations or resumes can run on this version.',
        confirmLabel: 'Retire',
        cancelLabel: 'Cancel',
        variant: 'danger',
        destructive: true,
      };

    default:
      throw new Error(`Unsupported version transition action: ${String(action)}`);
  }
}

// ---------------------------------------------------------------------------
// Overall business health view
// ---------------------------------------------------------------------------

/**
 * Summarizes overall business health across all registered versions.
 */
export function buildBusinessHealthView(
  versions: readonly BusinessVersionRow[] | readonly BusinessVersionDisplayRow[],
  activeVersion?: string | null,
): BusinessHealthView {
  if (versions.length === 0) {
    return {
      businessId: '',
      health: 'no-active',
      healthBadge: 'neutral',
      activeVersion: null,
      totalVersions: 0,
      enabledVersions: 0,
      drainingVersions: 0,
      retiredVersions: 0,
      disabledVersions: 0,
      hasActiveWorkers: false,
      summary: 'No registered versions',
    };
  }

  const businessId = versions[0]?.businessId ?? '';
  const totalVersions = versions.length;
  const enabledVersions = versions.filter((v) => v.status === 'ENABLED').length;
  const drainingVersions = versions.filter((v) => v.status === 'DRAINING').length;
  const retiredVersions = versions.filter((v) => v.status === 'RETIRED').length;
  const disabledVersions = versions.filter((v) => v.status === 'REGISTERED_DISABLED').length;

  // Resolve active version
  let resolvedActive: string | null = null;
  if (activeVersion !== undefined && activeVersion !== null) {
    resolvedActive = activeVersion;
  } else {
    const explicitActive = versions.find((v) => v.isActive === true);
    if (explicitActive) {
      resolvedActive = explicitActive.version;
    } else {
      const firstEnabled = versions.find((v) => v.status === 'ENABLED');
      resolvedActive = firstEnabled ? firstEnabled.version : null;
    }
  }

  // Assess worker activity for the active / enabled version
  const activeRow = versions.find((v) => v.version === resolvedActive);
  let hasActiveWorkers = false;
  let isDegraded = false;

  if (activeRow) {
    const isDisplay = 'statusBadge' in activeRow && 'health' in activeRow;
    const hb = isDisplay
      ? (activeRow as BusinessVersionDisplayRow).workerHeartbeat
      : resolveWorkerHeartbeat(activeRow as BusinessVersionRow);

    if (hb.status === 'online') {
      hasActiveWorkers = true;
    } else if (hb.status === 'degraded') {
      hasActiveWorkers = true;
      isDegraded = true;
    } else if (hb.status === 'offline' || hb.status === 'none') {
      if (isDisplay) {
        hasActiveWorkers = (activeRow as BusinessVersionDisplayRow).workerHeartbeat.workerCount > 0;
      } else {
        const rawRow = activeRow as BusinessVersionRow;
        if (
          rawRow.workerCount !== undefined ||
          rawRow.workerHealth !== undefined ||
          rawRow.workerHeartbeat !== undefined ||
          rawRow.lastHeartbeatAt !== undefined
        ) {
          hasActiveWorkers = false;
        } else if (rawRow.status === 'ENABLED') {
          hasActiveWorkers = true;
        }
      }
    }
  } else if (enabledVersions > 0) {
    hasActiveWorkers = true;
  }

  // Determine overall health classification & summary
  let health: OverallBusinessHealth;
  let healthBadge: VersionStatusBadge;
  let summary: string;

  if (enabledVersions === 0) {
    if (drainingVersions > 0) {
      health = 'draining';
      healthBadge = 'warning';
      summary = `Active version is draining (${drainingVersions} draining, no enabled version)`;
    } else if (retiredVersions === totalVersions) {
      health = 'retired';
      healthBadge = 'neutral';
      summary = 'All versions are retired';
    } else {
      health = 'no-active';
      healthBadge = 'neutral';
      summary = 'No active or enabled version';
    }
  } else {
    // enabledVersions > 0
    if (!hasActiveWorkers) {
      health = 'no-active';
      healthBadge = 'neutral';
      summary = resolvedActive
        ? `Version ${resolvedActive} is enabled but has no active workers`
        : 'Active version has no active workers';
    } else if (isDegraded) {
      health = 'degraded';
      healthBadge = 'warning';
      summary = resolvedActive
        ? `Version ${resolvedActive} worker heartbeat degraded`
        : 'Worker heartbeat degraded';
    } else {
      health = 'healthy';
      healthBadge = 'success';
      summary =
        drainingVersions > 0
          ? `Version ${resolvedActive ?? 'active'} healthy (${drainingVersions} draining)`
          : `Version ${resolvedActive ?? 'active'} healthy`;
    }
  }

  return {
    businessId,
    health,
    healthBadge,
    activeVersion: resolvedActive,
    totalVersions,
    enabledVersions,
    drainingVersions,
    retiredVersions,
    disabledVersions,
    hasActiveWorkers,
    summary,
  };
}
