/**
 * Pure view-model functions for the Operation Detail page (P6-06 headless).
 *
 * All functions are pure: no I/O, no framework, no authorization decisions.
 * They map wire/domain shapes into UI-ready models for operation detail,
 * result display, artifact links, cancel/resume actions, and human-wait forms.
 *
 * Immutable invariants:
 *  - Terminal operations (SUCCEEDED/FAILED/CANCELLED/TIMED_OUT) are frozen.
 *  - Cancel is available for non-terminal, non-cancel-requested states.
 *  - Resume is only available when state is WAITING_INPUT and a live wait row exists.
 *  - Resume payload includes a CAS token to prevent stale concurrent resumes.
 *  - No raw error bodies, no credential echoes, no secrets in any display shape.
 */

import type { OperationDetail, ArtifactRef, HumanWaitView, OperationState } from '@du/contracts';
import { TERMINAL_OPERATION_STATES } from '@du/contracts';

// ---------------------------------------------------------------------------
// Supplementary types for operation detail view models
// ---------------------------------------------------------------------------

/** Badge severity for the status indicator. */
export type OperationStatusBadge = 'success' | 'error' | 'warning' | 'info' | 'neutral';

/** Display-safe status label and badge. */
export interface OperationStatusDisplay {
  state: OperationState;
  label: string;
  badge: OperationStatusBadge;
  /** True for terminal states — no further mutations possible. */
  terminal: boolean;
}

/** Display-safe artifact entry. The download URL is relative and grant-gated on the server. */
export interface ArtifactDisplayRow {
  artifactId: string;
  role: string;
  fileName: string;
  mimeType: string;
  /** Human-readable file size, e.g. "128 KB", or empty when unavailable. */
  sizeDisplay: string;
  /** Relative download URL from the wire; the server validates the grant. */
  downloadUrl: string | null;
}

/** Full operation detail view model for the admin operation detail page. */
export interface OperationDetailView {
  id: string;
  businessId: string;
  businessVersion: string;
  action: string;
  status: OperationStatusDisplay;
  /** Progress percent (0–100). */
  progressPercent: number;
  progressMessage: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string | null;
  /** ISO timestamp of replay source, null for original submissions. */
  replayOf: string | null;
  artifacts: ArtifactDisplayRow[];
  /** Inline error for display; null when none or still in-flight. */
  errorDisplay: { code: string; title: string; detail: string } | null;
  /** Human-wait form model; only present when state is WAITING_INPUT. */
  humanWaitForm: HumanWaitFormModel | null;
  /** Self link from the wire. */
  selfLink: string;
  /** Result link from the wire. */
  resultLink: string;
}

// ---------------------------------------------------------------------------
// Human-wait form model (renderHumanWaitForm)
// ---------------------------------------------------------------------------

/** Widget types derived from JSON Schema for human-wait input rendering. */
export type HumanWaitFieldWidget = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'object' | 'array';

/** One field in the rendered human-wait form. */
export interface HumanWaitFormField {
  name: string;
  label: string;
  widget: HumanWaitFieldWidget;
  required: boolean;
  description: string;
  /** For 'select' widgets: allowed enum values. */
  options: { value: string; label: string }[];
  /** Example or default from the schema, if any (never a live credential). */
  placeholder: string;
}

/** Full rendered human-wait form model (pure; no I/O). */
export interface HumanWaitFormModel {
  waitId: string;
  /** ISO expiry timestamp; the UI can compute a countdown from this. */
  expiresAt: string;
  fields: HumanWaitFormField[];
  /** True when the wait has already expired (server will reject resume). */
  isExpired: boolean;
}

// ---------------------------------------------------------------------------
// Resume payload
// ---------------------------------------------------------------------------

/** Typed resume request payload for POST /operations/:id/resume. */
export interface ResumePayload {
  waitId: string;
  stepIndex: number;
  /** CAS token from the wait row; prevents stale concurrent resumes. */
  casToken: string;
  /** Operator-supplied input data keyed by field name. */
  inputData: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<OperationState, string> = {
  PENDING_INGESTION: 'Pending ingestion',
  ACCEPTED: 'Accepted',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  WAITING_CHILDREN: 'Waiting for children',
  WAITING_INPUT: 'Waiting for input',
  RETRY_PENDING: 'Retry pending',
  CANCEL_REQUESTED: 'Cancel requested',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  TIMED_OUT: 'Timed out',
};

const STATE_BADGE: Record<OperationState, OperationStatusBadge> = {
  PENDING_INGESTION: 'info',
  ACCEPTED: 'info',
  QUEUED: 'info',
  RUNNING: 'info',
  WAITING_CHILDREN: 'info',
  WAITING_INPUT: 'warning',
  RETRY_PENDING: 'warning',
  CANCEL_REQUESTED: 'warning',
  SUCCEEDED: 'success',
  FAILED: 'error',
  CANCELLED: 'neutral',
  TIMED_OUT: 'error',
};

/** Build the status display block for a given operation state. */
export function buildOperationStatusDisplay(state: OperationState): OperationStatusDisplay {
  return {
    state,
    label: STATE_LABEL[state],
    badge: STATE_BADGE[state],
    terminal: TERMINAL_OPERATION_STATES.includes(state),
  };
}

// ---------------------------------------------------------------------------
// Artifact display helper
// ---------------------------------------------------------------------------

function formatSizeDisplay(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toArtifactDisplayRow(ref: ArtifactRef): ArtifactDisplayRow {
  return {
    artifactId: ref.artifactId,
    role: ref.role ?? 'output',
    fileName: ref.fileName ?? ref.artifactId,
    mimeType: ref.mimeType ?? 'application/octet-stream',
    sizeDisplay: formatSizeDisplay(ref.sizeBytes),
    downloadUrl: ref.download ?? null,
  };
}

// ---------------------------------------------------------------------------
// formatOperationDetailView
// ---------------------------------------------------------------------------

/**
 * Map a wire `OperationDetail` (plus artifacts from the result envelope or
 * the stored artifact list) to a fully-typed admin detail view model.
 *
 * Pure function: no I/O, no mutation.
 *
 * @param operation - Wire operation detail (from GET /api/v1/operations/:id).
 * @param artifacts - Artifact refs attached to this operation (may be empty).
 * @param now       - Current ISO timestamp for expired-wait detection (defaults to Date.now).
 */
export function formatOperationDetailView(
  operation: OperationDetail,
  artifacts: ArtifactRef[] = [],
  now: string = new Date().toISOString(),
): OperationDetailView {
  const status = buildOperationStatusDisplay(operation.state);

  const errorDisplay =
    operation.error
      ? {
          code: operation.error.code,
          title: operation.error.title,
          detail: operation.error.detail ?? '',
        }
      : null;

  const humanWaitForm =
    operation.wait && operation.state === 'WAITING_INPUT'
      ? renderHumanWaitForm(operation.wait, now)
      : null;

  return {
    id: operation.id,
    businessId: operation.businessId,
    businessVersion: operation.businessVersion,
    action: operation.action,
    status,
    progressPercent: operation.progress.percent,
    progressMessage: operation.progress.message ?? '',
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    deadlineAt: operation.deadlineAt,
    replayOf: operation.replayOf ?? null,
    artifacts: artifacts.map(toArtifactDisplayRow),
    errorDisplay,
    humanWaitForm,
    selfLink: operation.links.self,
    resultLink: operation.links.result,
  };
}

// ---------------------------------------------------------------------------
// renderHumanWaitForm
// ---------------------------------------------------------------------------

/**
 * Derive a widget from a JSON Schema property descriptor.
 * Keeps the same safe-fallback semantics as mapSchemaToWidget in profile view models.
 */
function deriveHumanWaitWidget(schema: Record<string, unknown>): HumanWaitFieldWidget {
  if (typeof schema['widget'] === 'string') {
    const w = schema['widget'] as string;
    if (
      w === 'text' || w === 'textarea' || w === 'number' ||
      w === 'boolean' || w === 'select' || w === 'object' || w === 'array'
    ) {
      return w as HumanWaitFieldWidget;
    }
  }
  const type = schema['type'];
  if (type === 'boolean') return 'boolean';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'object') return 'object';
  if (type === 'array') return 'array';
  if (Array.isArray(schema['enum'])) return 'select';
  return 'text';
}

/**
 * Build enumerated options list for a 'select' widget from JSON Schema `enum`.
 * Values are coerced to strings; all other types are dropped.
 */
function buildEnumOptions(schema: Record<string, unknown>): { value: string; label: string }[] {
  const enumValues = schema['enum'];
  if (!Array.isArray(enumValues)) return [];
  return enumValues
    .filter((v): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map((v) => {
      const str = String(v);
      return { value: str, label: str };
    });
}

/**
 * Render a typed form model from a `HumanWaitView` for display in the
 * operation detail WAITING_INPUT panel.
 *
 * The `inputSchema` is a JSON Schema Draft 2020-12 compatible object whose
 * top-level `properties` define the form fields. Unknown or complex widget
 * types fall back to `'text'`. No data from `uiSchema` is surfaced verbatim
 * (only `title`, `description`, `placeholder`, and `ui:widget` are consulted).
 *
 * @param waitRow - HumanWaitView from the wire (GET /api/v1/operations/:id).
 * @param now     - Current ISO timestamp for expiry detection.
 */
export function renderHumanWaitForm(
  waitRow: HumanWaitView,
  now: string = new Date().toISOString(),
): HumanWaitFormModel {
  const isExpired = new Date(now) >= new Date(waitRow.expiresAt);

  const schema = waitRow.inputSchema;
  const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];

  // Merge uiSchema overrides (only safe display fields: widget, title, description, placeholder).
  const uiSchema = (waitRow.uiSchema ?? {}) as Record<string, Record<string, unknown>>;

  const fields: HumanWaitFormField[] = Object.entries(properties).map(([name, propSchema]) => {
    const uiOverride = uiSchema[name] ?? {};

    // Widget: prefer uiSchema['ui:widget'] override, then derive from property schema.
    const uiWidget = uiOverride['ui:widget'];
    let widget: HumanWaitFieldWidget;
    if (typeof uiWidget === 'string' && (
      uiWidget === 'text' || uiWidget === 'textarea' || uiWidget === 'number' ||
      uiWidget === 'boolean' || uiWidget === 'select' || uiWidget === 'object' || uiWidget === 'array'
    )) {
      widget = uiWidget as HumanWaitFieldWidget;
    } else {
      widget = deriveHumanWaitWidget(propSchema);
    }

    const label =
      (typeof uiOverride['ui:title'] === 'string' ? uiOverride['ui:title'] : null) ??
      (typeof propSchema['title'] === 'string' ? propSchema['title'] : null) ??
      name;

    const description =
      (typeof uiOverride['ui:description'] === 'string' ? uiOverride['ui:description'] : null) ??
      (typeof propSchema['description'] === 'string' ? propSchema['description'] : null) ??
      '';

    const placeholder =
      (typeof uiOverride['ui:placeholder'] === 'string' ? uiOverride['ui:placeholder'] : null) ??
      (typeof propSchema['examples'] === 'object' && Array.isArray(propSchema['examples'])
        ? String(propSchema['examples'][0] ?? '')
        : '') ??
      '';

    const options = widget === 'select' ? buildEnumOptions(propSchema) : [];

    return {
      name,
      label,
      widget,
      required: required.includes(name),
      description,
      options,
      placeholder,
    };
  });

  return {
    waitId: waitRow.waitId,
    expiresAt: waitRow.expiresAt,
    fields,
    isExpired,
  };
}

// ---------------------------------------------------------------------------
// canCancelOperation
// ---------------------------------------------------------------------------

/** States that can be cancelled by an operator. */
const CANCELLABLE_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'ACCEPTED',
  'QUEUED',
  'RUNNING',
  'WAITING_CHILDREN',
  'WAITING_INPUT',
  'RETRY_PENDING',
]);

/**
 * True when the operation is in a state that can be cancelled.
 *
 * Cancelled, timed-out, succeeded, failed, and cancel-already-requested
 * operations cannot be cancelled again. Display-only gate; the server
 * enforces authorization.
 */
export function canCancelOperation(state: OperationState): boolean {
  return CANCELLABLE_STATES.has(state);
}

// ---------------------------------------------------------------------------
// canResumeOperation
// ---------------------------------------------------------------------------

/**
 * True when an operation can be resumed by an operator. Resume requires:
 *  1. Operation is in `WAITING_INPUT` state.
 *  2. A live (non-expired) human-wait row exists with status OPEN.
 *
 * @param state       - Current operation state.
 * @param waitRow     - HumanWaitView from the wire (null when absent/already answered).
 * @param now         - Current ISO timestamp for expiry detection.
 */
export function canResumeOperation(
  state: OperationState,
  waitRow: HumanWaitView | null | undefined,
  now: string = new Date().toISOString(),
): boolean {
  if (state !== 'WAITING_INPUT') return false;
  if (!waitRow) return false;
  // Expired waits cannot be resumed (server will reject with 409).
  return new Date(now) < new Date(waitRow.expiresAt);
}

// ---------------------------------------------------------------------------
// buildResumePayload
// ---------------------------------------------------------------------------

/**
 * Construct a typed resume request payload for POST /operations/:id/resume.
 *
 * The CAS token (`casToken`) is the `waitId` from the human-wait row; it
 * prevents two concurrent operators from both successfully resuming the same
 * wait (the second will receive a 409 Conflict from the server).
 *
 * @param inputData  - Validated operator-supplied form data (field name → value).
 * @param stepIndex  - Zero-based step index from the wait row context.
 * @param casToken   - CAS token string (typically the `waitId`).
 */
export function buildResumePayload(
  inputData: Record<string, unknown>,
  stepIndex: number,
  casToken: string,
): ResumePayload {
  return {
    waitId: casToken,
    stepIndex,
    casToken,
    inputData,
  };
}

// ---------------------------------------------------------------------------
// Replay action helpers
// ---------------------------------------------------------------------------

/**
 * True when a replay submission can be offered for this operation.
 * Replays are only meaningful once an operation has reached a terminal state.
 * The new operation created by a replay is independent; this is purely a
 * display affordance — the server validates auth, profile, and quota.
 */
export function canReplayOperation(state: OperationState): boolean {
  return TERMINAL_OPERATION_STATES.includes(state);
}

/**
 * Display label for the replay action button, contextualised by state.
 */
export function replayActionLabel(state: OperationState): string {
  switch (state) {
    case 'FAILED':
      return 'Retry (new operation)';
    case 'CANCELLED':
      return 'Rerun (new operation)';
    case 'TIMED_OUT':
      return 'Retry after timeout (new operation)';
    default:
      return 'Replay (new operation)';
  }
}
