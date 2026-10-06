/**
 * Pure view-model functions for the Admin UI (P6-01 headless foundation).
 *
 * All functions are pure: no I/O, no framework, no authorization decisions.
 * They map server-side wire/domain shapes into UI-ready view models.
 * Authorization is enforced by the server; these functions only describe
 * what a renderer with a given role *may display*.
 */

import type {
  AdminBusinessView,
  AdminRole,
  AdminSection,
  BusinessViewState,
  ConnectorCapabilityOption,
  ConnectorConfigView,
  ConnectorEndpointDisplay,
  ConnectorListViewState,
  ConnectorRevisionRow,
  ConnectorRevisionState,
  ConnectorTestResult,
  ConnectorTestResultKind,
  DraftDiffEntry,
  DraftDiffReport,
  DraftIssue,
  DraftSlotSpec,
  DraftValidationInput,
  DraftValidationResult,
  FieldWidget,
  NavItem,
  OperationRow,
  OperationsListView,
  PageState,
  ProfileDraft,
  ProfileFormField,
  ProfileFormModel,
  ProfileSchemaInput,
  ProfileSection,
  RotateSecretState,
} from './types';
import { ROLE_ORDER } from './types';
import { getCanonicalNavItems } from './p6-01-shell-fixtures';

// Re-export types so consumers only need one import surface.
export * from './types';

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Canonical section list for the admin shell. Paths are relative to /admin.
 * NAV-DEDUPE (2026-10-05): single source of truth — the list is owned by
 * `./p6-01-shell-fixtures` (`getCanonicalNavItems`), the same nav the router
 * and renderer consume; this export re-references it for view-model consumers.
 */
export const ALL_NAV_ITEMS: readonly NavItem[] = getCanonicalNavItems();

/**
 * True when `role` satisfies the item's `requiredRole`.
 * This is a *display* gate only; the server must independently authorize.
 */
export function canSeeNavItem(role: AdminRole, item: NavItem): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[item.requiredRole];
}

/** Filter the canonical nav list to items visible for a role, preserving order. */
export function visibleNavItems(role: AdminRole): NavItem[] {
  return ALL_NAV_ITEMS.filter((item) => canSeeNavItem(role, item));
}

/** Resolve the section for a path, or null if the path is not an admin route. */
export function sectionForPath(path: string): AdminSection | null {
  const hit = ALL_NAV_ITEMS.find((item) => path === item.path || path.startsWith(item.path + '/'));
  return hit ? hit.section : null;
}

// ---------------------------------------------------------------------------
// Page state helpers
// ---------------------------------------------------------------------------

export function loadingState(): PageState {
  return { kind: 'loading' };
}

export function emptyState(message: string): PageState {
  return { kind: 'empty', message };
}

export function errorState(message: string): PageState {
  return { kind: 'error', message };
}

export function forbiddenState(message: string): PageState {
  return { kind: 'forbidden', message };
}

export function readyState(): PageState {
  return { kind: 'ready' };
}

// ---------------------------------------------------------------------------
// Operations list
// ---------------------------------------------------------------------------

/**
 * Minimal wire shape the operations endpoint returns. Kept structural so the
 * view model does not depend on the exact contract package version.
 */
export interface OperationWire {
  id: string;
  businessId: string;
  businessVersion: string;
  action: string;
  state: OperationRow['state'];
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string | null;
}

/** Map one wire operation to a display row. Pure projection, no reordering. */
export function toOperationRow(op: OperationWire): OperationRow {
  return {
    id: op.id,
    businessId: op.businessId,
    businessVersion: op.businessVersion,
    action: op.action,
    state: op.state,
    stateVersion: op.stateVersion,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    deadlineAt: op.deadlineAt,
  };
}

/** Build the operations list view from a page of wire operations. */
export function buildOperationsListView(
  ops: OperationWire[],
  total: number,
  page: number,
  pageSize: number,
): OperationsListView {
  return {
    rows: ops.map(toOperationRow),
    total,
    page,
    pageSize,
  };
}

/** Coarse operation health used for list badge tinting. */
export type OperationHealth = 'ok' | 'in-flight' | 'attention' | 'terminal-bad';

export function operationHealth(row: OperationRow): OperationHealth {
  switch (row.state) {
    case 'SUCCEEDED':
      return 'ok';
    case 'FAILED':
    case 'CANCELLED':
    case 'TIMED_OUT':
      return 'terminal-bad';
    case 'WAITING_INPUT':
      return 'attention';
    default:
      return 'in-flight';
  }
}

// ---------------------------------------------------------------------------
// Business detail
// ---------------------------------------------------------------------------

/** Minimal manifest subset the business detail view needs. */
export interface BusinessManifestSummary {
  title?: string;
  description?: string;
  actions?: Array<{ name: string }>;
}

export interface BusinessRecord {
  businessId: string;
  version: string;
  registeredAt: string;
  manifest: BusinessManifestSummary;
}

/** Build the ready-state business detail view from a registry record. */
export function buildBusinessView(record: BusinessRecord): AdminBusinessView {
  return {
    businessId: record.businessId,
    version: record.version,
    title: record.manifest.title ?? record.businessId,
    description: record.manifest.description ?? '',
    actionCount: record.manifest.actions?.length ?? 0,
    registeredAt: record.registeredAt,
  };
}

/**
 * Discriminated union reducer for the business page. Lets a renderer handle
 * "business exists", "unknown business", loading and error uniformly.
 */
export function businessViewState(
  input:
    | { kind: 'loaded'; record: BusinessRecord }
    | { kind: 'not-found'; businessId: string }
    | { kind: 'loading' }
    | { kind: 'error'; message: string },
): BusinessViewState {
  switch (input.kind) {
    case 'loaded':
      return { kind: 'ready', business: buildBusinessView(input.record) };
    case 'not-found':
      return { kind: 'not-registered', businessId: input.businessId };
    case 'loading':
      return { kind: 'loading' };
    case 'error':
      return { kind: 'error', message: input.message };
  }
}

// ---------------------------------------------------------------------------
// Profile form (schema-driven) & draft view models (P6-03)
// ---------------------------------------------------------------------------

export {
  KNOWN_WIDGETS,
  mapSchemaToWidget,
  coerceWidget,
  buildProfileFormField,
  buildProfileFormModel,
  checkProfileRevision,
  displayValue,
  validateProfileDraft,
  diffProfileRevision,
  diffProfileDraft,
  type SchemaWidgetDescriptor,
  type WidgetMappingResult,
  type RevisionCheck,
  type RevisionDiffOptions,
} from './profile-view-models';

// ---------------------------------------------------------------------------
// Connector configuration (P6-04 pure view models)
// ---------------------------------------------------------------------------

/**
 * Masked display for a connector endpoint hostname. The raw URL is never
 * rendered — only the last domain label pattern is exposed.
 *
 * "api.openai.com"       → "***.openai.com"
 * "localhost:8080"       → "***"
 * "" / undefined input    → "***"
 *
 * Display-only; never flows into an API payload.
 */
export function maskConnectorHost(rawHost: string | undefined): string {
  if (!rawHost || rawHost.length === 0) return '***';
  const withoutPort = rawHost.split(':')[0]!;
  if (withoutPort.length === 0 || withoutPort === 'localhost') return '***';
  const parts = withoutPort.split('.');
  if (parts.length < 2) return '***';
  return `***.${parts.slice(-2).join('.')}`;
}

/**
 * Build a display-only endpoint projection from a raw wire endpoint.
 * The wire `url` is accepted but only used to derive the masked host —
 * the original string is discarded and never stored in the view model.
 */
export function buildConnectorEndpointDisplay(wire: {
  kind: string;
  url?: string;
}): ConnectorEndpointDisplay {
  let host = '';
  if (wire.url) {
    try {
      host = new URL(wire.url).host;
    } catch {
      host = wire.url;
    }
  }
  return { kind: wire.kind, maskedHost: maskConnectorHost(host) };
}

/**
 * Assemble the connector configuration view for a single connector from its
 * revision row, latest test result, and rotate-secret action state.
 * Pure projection — the row passed in must already carry a masked endpoint.
 */
export function buildConnectorConfigView(input: {
  revision: ConnectorRevisionRow;
  testResult: ConnectorTestResult;
  rotateState: RotateSecretState;
}): ConnectorConfigView {
  return {
    revision: input.revision,
    testResult: input.testResult,
    rotateState: input.rotateState,
  };
}

/**
 * Reduce a wire list to the connector list page state.
 * Handles loading / empty / error / ready without any I/O.
 */
export function buildConnectorListViewState(
  input:
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'loaded'; rows: ConnectorRevisionRow[] },
): ConnectorListViewState {
  if (input.kind === 'loading') return { kind: 'loading' };
  if (input.kind === 'error') return { kind: 'error', message: input.message };
  if (input.rows.length === 0) {
    return { kind: 'empty', message: 'No connectors configured' };
  }
  return { kind: 'ready', rows: input.rows };
}

/**
 * Map a raw test-action wire response to a safe display result.
 * Provider error bodies and credential strings must never flow through —
 * only the classified kind and a safe message survive.
 */
export function buildConnectorTestResult(wire: {
  ok: boolean;
  errorKind?:
    | 'provider-unavailable'
    | 'invalid-credential'
    | 'quota-exceeded'
    | 'timeout'
    | null;
  /** Pre-sanitized message from the server; never raw provider bodies. */
  message?: string;
  testedAt?: string | null;
}): ConnectorTestResult {
  if (wire.ok) {
    return {
      kind: 'success',
      message: wire.message ?? 'Connection OK',
      testedAt: wire.testedAt ?? null,
    };
  }
  const kind: ConnectorTestResultKind = wire.errorKind ?? 'provider-unavailable';
  const defaultMessages: Record<ConnectorTestResultKind, string> = {
    success: 'Connection OK',
    'provider-unavailable': 'Connector provider unavailable',
    'invalid-credential': 'Credential rejected by provider',
    'quota-exceeded': 'Provider quota exceeded',
    timeout: 'Connection test timed out',
    pending: 'Test in progress',
  };
  return {
    kind,
    message: wire.message ?? defaultMessages[kind],
    testedAt: wire.testedAt ?? null,
  };
}

/**
 * Table describing the rotate-secret action availability and copy-once
 * hint per state. The server enforces rotation auth/consent; this is purely
 * a display aid for buttons and banners.
 */
export interface RotateSecretActionView {
  state: RotateSecretState;
  /** Whether the "Rotate secret" button is actionable in this state. */
  actionable: boolean;
  /** Short label hint (e.g. "Rotate", "Rotating…", "Conflict — refresh"). */
  label: string;
  /** True when a just-completed rotation's new secret can be copied once. */
  copyOnceHint: boolean;
}

export function rotateSecretActionView(state: RotateSecretState): RotateSecretActionView {
  switch (state) {
    case 'idle':
      return { state, actionable: true, label: 'Rotate secret', copyOnceHint: false };
    case 'requested':
      return { state, actionable: false, label: 'Rotation requested…', copyOnceHint: false };
    case 'in-progress':
      return { state, actionable: false, label: 'Rotating…', copyOnceHint: false };
    case 'completed':
      // New secret shown once — copy-once, never re-fetchable.
      return { state, actionable: true, label: 'Rotate again', copyOnceHint: true };
    case 'conflict':
      return { state, actionable: true, label: 'Conflict — refresh', copyOnceHint: false };
  }
}

/**
 * True when a connector test action can be requested from this view.
 * The test is always explicit (never auto-run): disabled while the connector
 * is disabled, while a rotation is in flight, or while a test is pending.
 */
export function canRunConnectorTest(view: ConnectorConfigView): boolean {
  if (view.testResult.kind === 'pending') return false;
  if (view.rotateState === 'requested' || view.rotateState === 'in-progress') return false;
  return view.revision.state !== 'disabled';
}

/**
 * Capability tag available but the connector has never passed a live test —
 * surfaces a display hint that adapter capability ≠ proven connectivity.
 * Purely informational; no diagnostics expose secrets.
 */
export function connectorTestNeedsAttention(view: ConnectorConfigView): boolean {
  if (view.revision.state !== 'enabled') return false;
  return (
    view.testResult.kind === 'pending' ||
    view.testResult.kind === 'provider-unavailable' ||
    view.testResult.kind === 'invalid-credential' ||
    view.testResult.kind === 'quota-exceeded' ||
    view.testResult.kind === 'timeout'
  );
}
