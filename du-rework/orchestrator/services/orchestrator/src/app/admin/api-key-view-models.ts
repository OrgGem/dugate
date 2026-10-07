/**
 * Pure API Key View Models (P6-05 headless foundation).
 *
 * Scope: Pure functions that map API key wire/domain rows into UI-ready view
 * models: copy-once creation window, list projection (no raw key), revoke
 * guard, revoke confirmation, and grant assignment view.
 *
 * Hard rule: the raw API key value is accepted as input ONLY to
 * `buildApiKeyCreateView`, and the returned model never persists that value
 * in any field. After the create window closes, only a masked hint
 * (`raw.slice(0,4) + '…'`) is ever exposed. `buildApiKeyListView` must not
 * accept raw-key-bearing inputs at all — it operates on rows that already
 * carry the masked hint + metadata.
 *
 * Pure and offline: Zero DB activity, zero HTTP I/O, zero framework
 * dependencies, strict TypeScript with zero `any`.
 */

// ---------------------------------------------------------------------------
// Wire inputs
// ---------------------------------------------------------------------------

/**
 * Status of an API key as held on the server.
 * - `ACTIVE` — usable for inbound requests.
 * - `REVOKING` — in-flight revocation; should not accept new requests.
 * - `REVOKED` — terminally disabled; cannot be reactivated.
 */
export type ApiKeyStatus = 'ACTIVE' | 'REVOKING' | 'REVOKED';

/**
 * Wire row for an existing API key. The server has already discarded the raw
 * key value — only the masked prefix hint plus metadata is present.
 */
export interface ApiKeyRow {
  id: string;
  tenantId: string;
  /** First 4 chars of the raw key followed by `…`. Never the raw key. */
  maskedHint: string;
  /** Full prefix tag if the server distinguishes one (e.g. `du_live_`). */
  prefix: string;
  status: ApiKeyStatus;
  createdAt: string;
  /** ISO timestamp; null when never used. */
  lastUsedAt: string | null;
  /** Operator label; optional. */
  label: string | null;
  /** ISO timestamp; null when not revoked. */
  revokedAt: string | null;
}

/**
 * Wire row describing a grant — a (business, version, action) tuple that
 * the API key is allowed to invoke. Display-only projection; the server
 * remains the authorization authority.
 */
export interface ApiKeyGrantRow {
  businessId: string;
  businessVersion: string;
  action: string;
  /** When the grant was created. */
  grantedAt: string;
}

// ---------------------------------------------------------------------------
// View models (display only — never carries raw key)
// ---------------------------------------------------------------------------

/**
 * One row in the API key list page. Pure display projection — never carries
 * the raw key value.
 */
export interface ApiKeyListRow {
  id: string;
  tenantId: string;
  maskedHint: string;
  prefix: string;
  status: ApiKeyStatus;
  statusBadge: 'success' | 'warning' | 'error' | 'neutral';
  statusLabel: string;
  createdAt: string;
  lastUsedAt: string | null;
  label: string | null;
  revokedAt: string | null;
  /** True when revoke is permitted; matches the guard helper. */
  canRevoke: boolean;
}

/**
 * The full list view. Includes a `total` so renderers can show pagination
 * without re-counting.
 */
export interface ApiKeyListView {
  rows: ApiKeyListRow[];
  total: number;
}

/**
 * The copy-once creation window. Holds only the masked hint in the model —
 * the caller MUST surface the raw key value to the operator on their own
 * (e.g. via a one-shot banner) and discard it client-side once acknowledged.
 */
export interface ApiKeyCreateView {
  id: string;
  tenantId: string;
  maskedHint: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  /**
   * True exactly when the model was constructed from a non-empty raw key.
   * Renderers should show the copy-once banner only while this is true.
   */
  copyOnceAvailable: boolean;
  /**
   * Human-readable hint explaining the copy-once contract. Renderer-supplied
   * or default; never echoes the raw key.
   */
  copyOnceNotice: string;
}

/**
 * Confirmation model for a revoke action. The renderer asks the operator to
 * confirm before dispatching the revoke call.
 */
export interface ApiKeyRevokeConfirmView {
  id: string;
  tenantId: string;
  maskedHint: string;
  status: ApiKeyStatus;
  /** Pre-rendered warning copy; static but kept in the model for i18n. */
  warning: string;
  /** When true, the renderer should disable the confirm button. */
  confirmDisabled: boolean;
}

/**
 * One display row in the grant list.
 */
export interface ApiKeyAssignmentRow {
  businessId: string;
  businessVersion: string;
  action: string;
  grantedAt: string;
}

/**
 * Assignment view for a single API key. Includes the key's masked hint plus
 * the list of grants that authorize it to call specific (business, version,
 * action) tuples.
 */
export interface ApiKeyAssignmentView {
  id: string;
  tenantId: string;
  maskedHint: string;
  status: ApiKeyStatus;
  grants: ApiKeyAssignmentRow[];
  totalGrants: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a masked hint from a raw key. Returns `''` for falsy input so the
 * caller never accidentally echoes an empty/missing raw key as a hint.
 *
 * Format: first 4 chars + `'…'` when raw length >= 4; for very short keys
 * (which should not happen in production but may appear in tests) the entire
 * value is masked as `'•'.repeat(n) + '…'`.
 */
export function maskApiKey(raw: string): string {
  if (!raw) return '';
  if (raw.length >= 4) return raw.slice(0, 4) + '…';
  return '•'.repeat(raw.length) + '…';
}

/**
 * Map a status enum to a renderer-safe badge variant.
 */
export function apiKeyStatusBadge(status: ApiKeyStatus): 'success' | 'warning' | 'error' | 'neutral' {
  return API_KEY_STATUS_META[status].badge;
}

/**
 * Human-readable label for the badge.
 */
export function apiKeyStatusLabel(status: ApiKeyStatus): string {
  return API_KEY_STATUS_META[status].label;
}

const API_KEY_STATUS_META: {
  readonly [S in ApiKeyStatus]: { readonly badge: 'success' | 'warning' | 'error' | 'neutral'; readonly label: string };
} = {
  ACTIVE: { badge: 'success', label: 'Active' },
  REVOKING: { badge: 'warning', label: 'Revoking' },
  REVOKED: { badge: 'error', label: 'Revoked' },
};

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/**
 * Build the one-time creation window view.
 *
 * The `rawKey` parameter is required so callers cannot accidentally render a
 * model that forgot to capture the raw key — but the returned model NEVER
 * stores the raw key. Only a masked hint is included.
 *
 * `copyOnceAvailable` is true exactly when `rawKey` is a non-empty string.
 * Renderers must show the copy-once banner only while this flag is true and
 * must never persist `rawKey` into any other view model.
 */
const NOTICES = {
  copyOnceAvailable: 'Copy this key now. You will not be able to see it again.',
  copyOnceAcknowledged: 'Key already acknowledged. The raw value is no longer available.',
  revokeWarning:
    'Revoking this key permanently disables it. Outstanding operations in flight will fail.',
} as const;

export function buildApiKeyCreateView(input: {
  id: string;
  tenantId: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  /** Raw key produced by the server at create time. Required. */
  rawKey: string;
}): ApiKeyCreateView {
  const copyOnceAvailable = input.rawKey.length > 0;
  return {
    id: input.id,
    tenantId: input.tenantId,
    maskedHint: maskApiKey(input.rawKey),
    prefix: input.prefix,
    label: input.label,
    createdAt: input.createdAt,
    copyOnceAvailable,
    copyOnceNotice: copyOnceAvailable ? NOTICES.copyOnceAvailable : NOTICES.copyOnceAcknowledged,
  };
}

/**
 * Build the list view projection. Each row carries only the masked hint
 * already supplied by the server — this function NEVER accepts a raw key.
 */
export function buildApiKeyListView(rows: readonly ApiKeyRow[]): ApiKeyListView {
  const projected: ApiKeyListRow[] = rows.map((row) => {
    const meta = API_KEY_STATUS_META[row.status];
    return {
      id: row.id,
      tenantId: row.tenantId,
      maskedHint: row.maskedHint,
      prefix: row.prefix,
      status: row.status,
      statusBadge: meta.badge,
      statusLabel: meta.label,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      label: row.label,
      revokedAt: row.revokedAt,
      canRevoke: canRevokeApiKey(row),
    };
  });
  return { rows: projected, total: projected.length };
}

/**
 * Returns true exactly when the key is in a state where a revoke dispatch
 * is permitted: status is `ACTIVE` and the key is not currently revoking.
 *
 * Strict: `REVOKING` keys already have an in-flight revoke and must not be
 * re-dispatched; `REVOKED` keys are terminal.
 */
export function canRevokeApiKey(key: Pick<ApiKeyRow, 'status'>): boolean {
  return key.status === 'ACTIVE';
}

/**
 * Build the confirmation view for a revoke action. Carries only the key ID
 * and masked hint — the renderer asks the operator to confirm before
 * dispatching. The confirm button is auto-disabled when the key is not in
 * a revokable state.
 */
export function buildApiKeyRevokeConfirm(
  key: Pick<ApiKeyRow, 'id' | 'tenantId' | 'maskedHint' | 'status'>,
): ApiKeyRevokeConfirmView {
  return {
    id: key.id,
    tenantId: key.tenantId,
    maskedHint: key.maskedHint,
    status: key.status,
    warning: NOTICES.revokeWarning,
    confirmDisabled: !canRevokeApiKey(key),
  };
}

/**
 * Build the assignment view: the key's masked hint plus the display rows
 * for each grant. Pure projection; the server still authorizes calls.
 */
export function buildApiKeyAssignmentView(
  key: Pick<ApiKeyRow, 'id' | 'tenantId' | 'maskedHint' | 'status'>,
  grants: readonly ApiKeyGrantRow[],
): ApiKeyAssignmentView {
  const projected: ApiKeyAssignmentRow[] = grants.map((g) => ({
    businessId: g.businessId,
    businessVersion: g.businessVersion,
    action: g.action,
    grantedAt: g.grantedAt,
  }));
  return {
    id: key.id,
    tenantId: key.tenantId,
    maskedHint: key.maskedHint,
    status: key.status,
    grants: projected,
    totalGrants: projected.length,
  };
}