/**
 * Pure Connector View Models (P6-04 headless foundation).
 *
 * Scope: Pure functions that map connector wire rows into UI-ready view
 * models: revision display, secret rotation confirmation (write-only secret
 * slots), and test result projection with sanitized error text.
 *
 * Hard rule: secret material is **write-only** in every projection. The
 * server stores the secret; the client only sends a replacement value when
 * rotating. No raw secret value, no credential header, no upstream response
 * body ever leaks into a view model. Tests assert that a configured raw
 * secret substring is absent from the JSON-serialized output.
 *
 * Pure and offline: Zero DB activity, zero HTTP I/O, zero framework
 * dependencies, strict TypeScript with zero `any`.
 */

import type {
  ConnectorEndpointDisplay,
  ConnectorRevisionRow,
  ConnectorRevisionState,
  ConnectorTestResult,
  ConnectorTestResultKind,
  RotateSecretState,
} from './types';

export * from './types';

// ---------------------------------------------------------------------------
// Wire inputs (extending the types declared in ./types)
// ---------------------------------------------------------------------------

/**
 * Status of a connector revision as held on the server.
 * - `enabled` — usable for inbound requests.
 * - `disabled` — administratively disabled; cannot serve traffic.
 * - `rotating` — secret rotation in flight; reflects the in-progress state.
 */
export type ConnectorState = ConnectorRevisionState;

/**
 * A secret slot on a connector revision. Carries a write-only marker
 * (`hasValue`) — true when the server has stored a secret for this slot —
 * and a short label suitable for a rotation form. The raw value is never
 * part of the wire shape; rotation submits a new value client-side and
 * the server accepts or rejects the write.
 */
export interface ConnectorSecretSlotRow {
  /** Stable name of the secret slot (e.g. `apiKey`, `webhookSecret`). */
  name: string;
  /** Human-readable label safe to render in a form. */
  label: string;
  /** True when a value is currently stored on the server. */
  hasValue: boolean;
  /** ISO timestamp of the last successful rotation; null when never rotated. */
  rotatedAt: string | null;
}

/**
 * Full wire input to `buildConnectorConfigRevisionView`: a revision row
 * plus its secret slots. The server never returns the raw secret values.
 */
export interface ConnectorRevisionInput {
  revision: ConnectorRevisionRow;
  secretSlots: readonly ConnectorSecretSlotRow[];
}

// ---------------------------------------------------------------------------
// View models (display only — never carry raw secret material)
// ---------------------------------------------------------------------------

/**
 * Display row for one secret slot. The slot's value lives only on the server;
 * this row only describes whether a value is currently held.
 */
export interface ConnectorSecretSlotView {
  name: string;
  label: string;
  /** True when the server has a value stored; renderer shows a mask badge. */
  hasValue: boolean;
  /** Renderer-safe status badge variant derived from `hasValue`. */
  statusBadge: 'success' | 'warning' | 'neutral';
  /** Renderer-safe human label. */
  statusLabel: string;
  rotatedAt: string | null;
}

/**
 * Full revision view. The `endpoint` is the masked projection from the
 * server — never the raw URL/host/credential.
 */
export interface ConnectorRevisionView {
  connectorId: string;
  revision: number;
  adapter: string;
  endpoint: ConnectorEndpointDisplay;
  capabilities: string[];
  state: ConnectorState;
  stateBadge: 'success' | 'warning' | 'neutral';
  stateLabel: string;
  createdAt: string;
  updatedAt: string;
  secretSlots: ConnectorSecretSlotView[];
  totalSecretSlots: number;
  /** True when at least one secret slot is currently configured. */
  hasAnySecret: boolean;
}

/**
 * Confirmation model for a rotate-secret action. The renderer asks the
 * operator to confirm before dispatching the write. Only the slot name and
 * the connector id flow into the model — never a current or proposed value.
 */
export interface SecretRotationConfirmView {
  connectorId: string;
  revision: number;
  slotName: string;
  slotLabel: string;
  /** Pre-rendered warning copy explaining the rotation's blast radius. */
  warning: string;
  /** True when the operator must type the slot name to enable the submit. */
  requireTypeToConfirm: boolean;
  /** When true, the renderer disables the submit button. */
  submitDisabled: boolean;
}

/**
 * Test result view. Explicit states (`success`, `failure`, `untested`) with
 * sanitized error text. The upstream error body and any header values must
 * never flow through; only a pre-baked message and a kind tag do.
 */
export interface ConnectorTestResultView {
  connectorId: string;
  revision: number;
  kind: ConnectorTestResultKind;
  /** Renderer-safe badge variant. */
  badge: 'success' | 'warning' | 'error' | 'neutral';
  /** Renderer-safe human label. */
  label: string;
  /** Pre-rendered, sanitized summary; safe for display. */
  message: string;
  testedAt: string | null;
  /** Always false — UI must never surface a retry affordance unless asked. */
  canRetry: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `maskConnectorHost` lives in `./view-models` (P6-04 legacy module) and is
 * re-exported explicitly from `admin/index.ts` to avoid the duplicate-export
 * collision. Do not redefine it here.
 */

const STATE_META: {
  readonly [S in ConnectorState]: { readonly badge: 'success' | 'warning' | 'neutral'; readonly label: string };
} = {
  enabled: { badge: 'success', label: 'Enabled' },
  disabled: { badge: 'neutral', label: 'Disabled' },
  rotating: { badge: 'warning', label: 'Rotating' },
};

export function connectorStateBadge(state: ConnectorState): 'success' | 'warning' | 'neutral' {
  return STATE_META[state].badge;
}

export function connectorStateLabel(state: ConnectorState): string {
  return STATE_META[state].label;
}

const SECRET_SLOT_META = {
  present: { badge: 'success' as const, label: 'Configured' },
  empty: { badge: 'warning' as const, label: 'Not configured' },
  rotating: { badge: 'warning' as const, label: 'Rotating' },
} as const;

function secretSlotBadge(hasValue: boolean): 'success' | 'warning' | 'neutral' {
  return hasValue ? SECRET_SLOT_META.present.badge : SECRET_SLOT_META.empty.badge;
}

function secretSlotLabel(hasValue: boolean): string {
  return hasValue ? SECRET_SLOT_META.present.label : SECRET_SLOT_META.empty.label;
}

const TEST_RESULT_META: {
  readonly [K in ConnectorTestResultKind]: {
    readonly badge: 'success' | 'warning' | 'error' | 'neutral';
    readonly label: string;
  };
} = {
  success: { badge: 'success', label: 'Success' },
  'provider-unavailable': { badge: 'warning', label: 'Provider unavailable' },
  'invalid-credential': { badge: 'error', label: 'Invalid credential' },
  'quota-exceeded': { badge: 'warning', label: 'Quota exceeded' },
  timeout: { badge: 'warning', label: 'Timeout' },
  pending: { badge: 'neutral', label: 'Pending' },
};

export function connectorTestBadge(kind: ConnectorTestResultKind): 'success' | 'warning' | 'error' | 'neutral' {
  return TEST_RESULT_META[kind].badge;
}

export function connectorTestLabel(kind: ConnectorTestResultKind): string {
  return TEST_RESULT_META[kind].label;
}

const NOTICES = {
  rotationWarning:
    'Rotating this secret invalidates the current value. Outstanding operations using the previous secret will fail until they are re-issued.',
} as const;

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/**
 * Build the revision view from a wire row and its secret slots. Pure
 * projection: the masked endpoint, capability list, and per-slot status
 * are derived without I/O. The raw secret material from the server is
 * never accepted as input — only the write-only `hasValue` marker is.
 */
export function buildConnectorConfigRevisionView(
  input: ConnectorRevisionInput,
): ConnectorRevisionView {
  const slotViews: ConnectorSecretSlotView[] = input.secretSlots.map((slot) => ({
    name: slot.name,
    label: slot.label,
    hasValue: slot.hasValue,
    statusBadge: secretSlotBadge(slot.hasValue),
    statusLabel: secretSlotLabel(slot.hasValue),
    rotatedAt: slot.rotatedAt,
  }));

  return {
    connectorId: input.revision.connectorId,
    revision: input.revision.revision,
    adapter: input.revision.adapter,
    endpoint: input.revision.endpoint,
    capabilities: [...input.revision.capabilities],
    state: input.revision.state,
    stateBadge: connectorStateBadge(input.revision.state),
    stateLabel: connectorStateLabel(input.revision.state),
    createdAt: input.revision.createdAt,
    updatedAt: input.revision.updatedAt,
    secretSlots: slotViews,
    totalSecretSlots: slotViews.length,
    hasAnySecret: slotViews.some((s) => s.hasValue),
  };
}

/**
 * Returns true exactly when a rotate-secret action is permitted for this
 * connector+slot. Strict: rotation is allowed only when the connector is
 * `enabled` (a disabled connector cannot accept writes) and the slot is
 * configured (`hasValue` true). A connector in `rotating` state must not
 * accept a second in-flight rotation.
 */
export function canRotateSecret(
  revision: Pick<ConnectorRevisionRow, 'state'>,
  slot: Pick<ConnectorSecretSlotRow, 'hasValue'>,
): boolean {
  return revision.state === 'enabled' && slot.hasValue === true;
}

/**
 * Build the rotation confirmation view. Carries only the connector id,
 * revision, slot name, and a renderer-safe warning string. The submit
 * button is auto-disabled when the guard rejects.
 */
export function buildSecretRotationConfirm(
  revision: Pick<ConnectorRevisionRow, 'connectorId' | 'revision' | 'state'>,
  slot: ConnectorSecretSlotRow,
): SecretRotationConfirmView {
  const allowed = canRotateSecret(revision, slot);
  return {
    connectorId: revision.connectorId,
    revision: revision.revision,
    slotName: slot.name,
    slotLabel: slot.label,
    warning: NOTICES.rotationWarning,
    requireTypeToConfirm: true,
    submitDisabled: !allowed,
  };
}

/**
 * Build the test result view. The error text is sanitized server-side;
 * this builder only maps the discriminated union to renderer-safe badge
 * and label. No upstream response body or header value is ever projected.
 */
export function buildConnectorTestResultView(
  connectorId: string,
  revision: number,
  result: ConnectorTestResult,
): ConnectorTestResultView {
  return {
    connectorId,
    revision,
    kind: result.kind,
    badge: connectorTestBadge(result.kind),
    label: connectorTestLabel(result.kind),
    message: result.message,
    testedAt: result.testedAt,
    canRetry: false,
  };
}

/**
 * Map a connector revision's lifecycle state into the rotate-secret sub-state.
 * Used to surface an in-progress rotation banner; pure derivation only.
 */
export function deriveRotateSecretState(state: ConnectorState): RotateSecretState {
  if (state === 'rotating') return 'in-progress';
  if (state === 'disabled') return 'idle';
  return 'idle';
}