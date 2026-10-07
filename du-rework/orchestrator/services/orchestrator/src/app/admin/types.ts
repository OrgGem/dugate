/**
 * Pure view-model types for the Admin UI (P6-01 headless foundation).
 *
 * These are UI-facing shapes: no runtime, no DB, no framework dependency.
 * The admin UI may not grant authorization; the server remains authoritative.
 * These types only describe what a UI renderer can safely display.
 */

import type { OperationState, OperationView } from '@du/contracts';

// ---------------------------------------------------------------------------
// Adminsection navigation
// ---------------------------------------------------------------------------

export type AdminSection =
  | 'businesses'
  | 'profiles'
  | 'operations'
  | 'connectors'
  | 'grants'
  | 'api-keys'
  | 'overview';

export interface NavItem {
  section: AdminSection;
  label: string;
  path: string;
  requiredRole: AdminRole;
}

export type AdminRole = 'admin' | 'operator' | 'viewer';

export const ROLE_ORDER: Record<AdminRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

// ---------------------------------------------------------------------------
// Shared page state
// ---------------------------------------------------------------------------

export type PageState =
  | { kind: 'loading' }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'ready' };

// ---------------------------------------------------------------------------
// Operation list ( /admin/operations )
// ---------------------------------------------------------------------------

export interface OperationRow {
  id: string;
  businessId: string;
  businessVersion: string;
  action: string;
  state: OperationState;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string | null;
}

export interface OperationsListView {
  rows: OperationRow[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Business detail ( /admin/businesses/:businessId )
// ---------------------------------------------------------------------------

export interface AdminBusinessView {
  businessId: string;
  version: string;
  description: string;
  title: string;
  actionCount: number;
  registeredAt: string;
}

export type BusinessViewState =
  | ({ kind: 'ready' } & { business: AdminBusinessView })
  | { kind: 'not-registered'; businessId: string }
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Profile form ( /admin/businesses/:id/profiles )
// ---------------------------------------------------------------------------

/** Widget kinds the form renderer can display. Unknown kinds fall back to 'text'. */
export type FieldWidget =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'secret'
  | 'readonly-hint';

export interface ProfileFormField {
  /** Slot name this field binds to (from the manifest). */
  slotName: string;
  label: string;
  widget: FieldWidget;
  required: boolean;
  helpText?: string;
  /** For 'select' widgets: allowed values from connector capabilities. */
  options?: { value: string; label: string }[];
  /** True when field was created as a safe fallback for an unknown widget kind. */
  unknownFallback?: boolean;
}

export interface ProfileSection {
  /** Manifest action that owns these slots. */
  actionName: string;
  fields: ProfileFormField[];
}

export interface ProfileFormModel {
  businessId: string;
  businessVersion: string;
  profileName: string;
  sections: ProfileSection[];
  /** Human-readable revision marker for staleness checks. */
  revisionLabel: string;
}

// ---------------------------------------------------------------------------
// Wire input types (as returned by the orchestrator / contracts)
// ---------------------------------------------------------------------------

/** Minimal connector capability snapshot for select-widget options. */
export interface ConnectorCapabilityOption {
  connectorId: string;
  capability: string;
  label: string;
}

/** Input to build a schema-driven profile form from a manifest. */
export interface ProfileSchemaInput {
  businessId: string;
  businessVersion: string;
  manifest: {
    actions: Array<{
      name: string;
      title?: string;
      slots?: Array<{
        name: string;
        required?: boolean;
        description?: string;
        widget?: string;
        options?: { value: string; label: string }[];
      }>;
    }>;
  };
  capabilityOptions: ConnectorCapabilityOption[];
  existingProfile?: { name: string; revision: number } | null;
}

// ---------------------------------------------------------------------------
// Profile draft (P6-03 pure client-side validation/diff)
// ---------------------------------------------------------------------------

/**
 * Raw per-slot value as held in a draft form before submit. All values are
 * strings at the boundary; widget-aware parsers convert them. `secretRefs`
 * write-only: never populated back into a rendered model from a server
 * projection — the server stores a reference handle and the client sees
 * only the existing-mask marker.
 */
export type DraftValue = string;

/** One slot's draft entry. */
export interface ProfileDraftEntry {
  slotName: string;
  /** Raw input as typed by the operator; empty string means "unset". */
  value: DraftValue;
}

/**
 * Typed pure draft of a profile form. The draft is the unit of work being
 * validated and diffed; it is never a server-authoritative state.
 */
export interface ProfileDraft {
  businessId: string;
  businessVersion: string;
  profileName: string;
  /** Form revision the draft was authored against (informational). */
  formRevision: number;
  /** All entries; slots not present are treated as unset. */
  entries: ProfileDraftEntry[];
}

/** Manifest slot as needed for draft validation. */
export interface DraftSlotSpec {
  name: string;
  required?: boolean;
  widget?: string;
  /** For 'select': explicitly allowed values from the manifest (fallback to capabilities). */
  options?: { value: string; label: string }[];
  /**
   * Locked slots cannot be edited and must keep their current value.
   * Server enforces this; the client uses it for early display/validation.
   */
  locked?: boolean;
  /** For 'locked' slots: the current (server) value. */
  lockedValue?: string;
}

/** Per-action section of draft slot specs, mirroring the manifest. */
export interface DraftActionSpec {
  actionName: string;
  slots: DraftSlotSpec[];
}

/** Capability subset the validator consults for select coercion. */
export interface DraftCapabilityOption {
  connectorId: string;
  capability: string;
}

/**
 * Pure input to `validateProfileDraft`. Carries the manifest slice needed to
 * validate, the capability catalog for connector slots, and the profile's
 * server state for staleness.
 */
export interface DraftValidationInput {
  draft: ProfileDraft;
  actions: DraftActionSpec[];
  capabilityOptions: DraftCapabilityOption[];
  /** Server profile for staleness detection; null when no profile exists. */
  serverProfile: { revision: number } | null;
}

/** Stable issue codes for table-driven tests and renderer switch statements. */
export type DraftIssueCode =
  | 'required-missing'
  | 'widget-invalid-value'
  | 'widget-unknown-fallback'
  | 'capability-mismatch'
  | 'locked-unchanged-violation'
  | 'stale-revision'
  | 'no-profile-target';

export interface DraftIssue {
  code: DraftIssueCode;
  slotName: string;
  /** Human-readable explanation; safe for display. */
  message: string;
}

export interface DraftValidationResult {
  ok: boolean;
  issues: DraftIssue[];
}

// ---------------------------------------------------------------------------
// Revision diff
// ---------------------------------------------------------------------------

/**
 * One observed change between the client draft and the server's current
 * persisted profile state. Secret slots are reported without echoing either
 * side's raw value; only the nature of the change is described.
 */
export type DraftDiffEntry =
  | { kind: 'added'; slotName: string }
  | { kind: 'removed'; slotName: string }
  | { kind: 'changed'; slotName: string; from: string; to: string }
  | { kind: 'changed-secret'; slotName: string }
  | { kind: 'unchanged'; slotName: string };

export interface DraftDiffReport {
  businessId: string;
  businessVersion: string;
  profileName: string;
  /** True when nothing differed. */
  identical: boolean;
  entries: DraftDiffEntry[];
}

// ---------------------------------------------------------------------------
// Connector configuration (P6-04 headless view models)
// ---------------------------------------------------------------------------

/**
 * Display-only connector endpoint summary. The real URL/host/credentials are
 * never included in view-model rows; only a masked indicator is exposed.
 */
export interface ConnectorEndpointDisplay {
  /** Short label or kind (e.g. "REST", "gRPC"), never the raw URL. */
  kind: string;
  /** Masked host hint (e.g. "***.example.com"); empty when unknown. */
  maskedHost: string;
}

/**
 * Wire representation of a connector revision as returned by the orchestrator
 * registry. The `endpoint` is the display projection — the raw URL/credentials
 * live only on the server.
 */
export interface ConnectorRevisionRow {
  connectorId: string;
  revision: number;
  adapter: string;
  /** Display-only endpoint projection — never contains secrets. */
  endpoint: ConnectorEndpointDisplay;
  /** Capability tags this revision declares. */
  capabilities: string[];
  state: ConnectorRevisionState;
  createdAt: string;
  updatedAt: string;
}

export type ConnectorRevisionState =
  | 'enabled'
  | 'disabled'
  | 'rotating';

/**
 * The result of a "test connection" action. Pure states — no raw provider
 * error bodies, no credential echoes.
 */
export type ConnectorTestResultKind =
  | 'success'
  | 'provider-unavailable'
  | 'invalid-credential'
  | 'quota-exceeded'
  | 'timeout'
  | 'pending';

export interface ConnectorTestResult {
  kind: ConnectorTestResultKind;
  /** Human-readable summary; safe for display. */
  message: string;
  /** ISO timestamp of when the test ran; null when still pending. */
  testedAt: string | null;
}

/**
 * Explicit rotate-secret action state. The server handles the actual rotation;
 * the UI only reflects the in-progress / completed / conflict phases.
 */
export type RotateSecretState =
  | 'idle'
  | 'requested'
  | 'in-progress'
  | 'completed'
  | 'conflict';

/**
 * Full connector configuration view model assembled from the revision row
 * plus the test result and rotation state. Display-only; the server remains
 * authoritative for all mutations.
 */
export interface ConnectorConfigView {
  revision: ConnectorRevisionRow;
  testResult: ConnectorTestResult;
  rotateState: RotateSecretState;
}

/**
 * View for an empty/loading/error connector list page.
 */
export type ConnectorListViewState =
  | { kind: 'loading' }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: ConnectorRevisionRow[] };

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { OperationView };
