/**
 * P6-04 Connector section data seam.
 *
 * Pure HTTP fetcher for the connector config / secret rotation / test
 * result pane. Discriminated `ConnectorFetchResult` drives the renderer.
 *
 * Design (mirrors `profile-section-data.ts`):
 * - When `connectorId === ''` the fetcher returns `kind: 'empty'` (the
 *   renderer shows "Pick a connector" instead of guessing one).
 * - When `jsonBaseUrl` is empty AND `manifestCatalog` (the in-process
 *   headless fixture) has an entry for `(connectorId, revision)`, the
 *   fetcher returns `kind: 'ok'` built from that catalog. This is the
 *   test-only path used by every offline admin suite.
 * - When `jsonBaseUrl` is set, the fetcher GETs
 *   `GET /api/v1/admin/connectors/:connectorId/revisions/:revision`
 *   with the admin bearer token and parses the JSON envelope
 *   `{ connectorId, revision, adapter, endpoint, capabilities, state,
 *   createdAt, updatedAt, secretSlots, testResult, rotateState }`.
 * - 401/403 → `unauthorized`. 404 → `not-found`. Other transport
 *   failures → `error`. Network/timeout → `error`.
 *
 * Hard rule: secret material is never accepted as input and never
 * present on the wire. The wire shape carries only `hasValue: boolean`
 * per slot — the server keeps the raw value.
 *
 * No DB, no Redis. `fetchImpl` is injectable. Strict TypeScript, zero
 * `any`.
 */

import { sanitizeUpstreamErrorBody } from './upstream-error-body';
import type {
  ConnectorConfigView,
  ConnectorEndpointDisplay,
  ConnectorRevisionState,
  ConnectorTestResult,
  ConnectorTestResultKind,
  RotateSecretState,
} from './types';
import type {
  ConnectorRevisionRow,
  ConnectorRevisionView,
  ConnectorSecretSlotRow,
  ConnectorSecretSlotView,
  ConnectorTestResultView,
  SecretRotationConfirmView,
} from './connector-view-models';
import {
  buildConnectorConfigRevisionView,
  buildConnectorTestResultView,
  buildSecretRotationConfirm,
  canRotateSecret,
  connectorStateBadge,
  connectorStateLabel,
  connectorTestBadge,
  connectorTestLabel,
  deriveRotateSecretState,
} from './connector-view-models';
import { safeTransportErrorText } from '../../http/errors';

// ---------------------------------------------------------------------------
// Wire shape (raw rows as the platform's GET would return them)
// ---------------------------------------------------------------------------

/**
 * Raw secret-slot row on the wire. The server never sends `value` —
 * only the write-only `hasValue` flag and a sanitized label.
 */
export interface ConnectorSecretSlotWireRow {
  name?: string;
  label?: string;
  hasValue?: boolean;
  rotatedAt?: string | null;
}

/**
 * Raw revision row on the wire. The endpoint is the masked display
 * projection (never contains credentials).
 */
export interface ConnectorRevisionWireRow {
  connectorId?: string;
  revision?: number;
  adapter?: string;
  endpoint?: ConnectorEndpointDisplay;
  capabilities?: string[];
  state?: ConnectorRevisionState;
  createdAt?: string;
  updatedAt?: string;
  secretSlots?: ConnectorSecretSlotWireRow[];
}

/**
 * Raw test result on the wire. `message` is sanitized server-side.
 */
export interface ConnectorTestResultWireRow {
  kind?: ConnectorTestResultKind;
  message?: string;
  testedAt?: string | null;
}

/**
 * Raw rotate-secret state on the wire.
 */
export interface ConnectorRotateStateWireRow {
  state?: RotateSecretState;
}

/**
 * Top-level envelope the platform returns from
 * `GET /api/v1/admin/connectors/:connectorId/revisions/:revision`.
 */
export interface ConnectorRevisionWireEnvelope {
  connectorId?: string;
  revision?: number;
  adapter?: string;
  endpoint?: ConnectorEndpointDisplay;
  capabilities?: string[];
  state?: ConnectorRevisionState;
  createdAt?: string;
  updatedAt?: string;
  secretSlots?: ConnectorSecretSlotWireRow[];
  testResult?: ConnectorTestResultWireRow;
  rotateState?: ConnectorRotateStateWireRow;
}

/**
 * Headless fixture input — used by tests when no platform JSON API
 * is wired. Mirrors the envelope but stays fully offline.
 */
export interface ConnectorRevisionCatalogEntry {
  connectorId: string;
  revision: number;
  adapter: string;
  endpoint: ConnectorEndpointDisplay;
  capabilities: string[];
  state: ConnectorRevisionState;
  createdAt: string;
  updatedAt: string;
  secretSlots: ConnectorSecretSlotRow[];
  testResult: ConnectorTestResult;
  rotateState: RotateSecretState;
}

// ---------------------------------------------------------------------------
// Fetcher input
// ---------------------------------------------------------------------------

/** Inputs the fetcher needs from the shell. */
export interface ConnectorFetcherInput {
  /** The connector id whose revisions to load. Empty → `kind: 'empty'`. */
  connectorId: string;
  /** Revision number. Default `0` means "the latest revision". */
  revision: number;
  /** Base URL of the orchestrator JSON API. */
  jsonBaseUrl: string;
  /** Admin bearer token (sent verbatim as `Authorization: Bearer …`). */
  adminToken: string;
  /** Optional in-process catalog (test-only). */
  manifestCatalog?: readonly ConnectorRevisionCatalogEntry[];
  /** Injected fetch. Default = global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 4000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Fetcher result (discriminated union — drives the renderer's screen state)
// ---------------------------------------------------------------------------

export type ConnectorFetchResult =
  | {
      kind: 'ok';
      connectorId: string;
      revision: number;
      revisionView: ConnectorRevisionView;
      /** Test-result view for the same revision (renderer-safe). */
      testResult: ConnectorTestResultView;
      /** Rotate-secret state for the same revision. */
      rotateState: RotateSecretState;
      /** Sanitized list of secret-slot rows (write-only `hasValue` only). */
      secretSlotViews: readonly ConnectorSecretSlotView[];
      /** Full revision row the renderer may project without re-shaping. */
      revisionRow: ConnectorRevisionRow;
      /** Revision label (e.g. `"#7"` for `revision: 7`). */
      revisionLabel: string;
    }
  | {
      kind: 'empty';
      connectorId: string;
      message: string;
    }
  | {
      kind: 'unauthorized';
      connectorId: string;
      message: string;
    }
  | {
      kind: 'not-found';
      connectorId: string;
      message: string;
    }
  | {
      kind: 'error';
      connectorId: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseState(raw: string | undefined): ConnectorRevisionState {
  switch (raw) {
    case 'enabled':
    case 'disabled':
    case 'rotating':
      return raw;
    default:
      return 'disabled';
  }
}

function normaliseKind(raw: string | undefined): ConnectorTestResultKind {
  switch (raw) {
    case 'success':
    case 'provider-unavailable':
    case 'invalid-credential':
    case 'quota-exceeded':
    case 'timeout':
    case 'pending':
      return raw;
    default:
      return 'pending';
  }
}

function normaliseRotateState(raw: string | undefined): RotateSecretState {
  switch (raw) {
    case 'idle':
    case 'requested':
    case 'in-progress':
    case 'completed':
    case 'conflict':
      return raw;
    default:
      return 'idle';
  }
}

function normaliseEndpoint(
  raw: ConnectorEndpointDisplay | undefined,
): ConnectorEndpointDisplay {
  if (!raw || typeof raw !== 'object') {
    return { kind: 'unknown', maskedHost: '' };
  }
  const kind = typeof raw.kind === 'string' ? raw.kind : 'unknown';
  const maskedHost = typeof raw.maskedHost === 'string' ? raw.maskedHost : '';
  return { kind, maskedHost };
}

function pickCatalogEntry(
  input: ConnectorFetcherInput,
  connectorId: string,
  revision: number,
): ConnectorRevisionCatalogEntry | undefined {
  const catalog = input.manifestCatalog ?? [];
  if (catalog.length === 0) return undefined;
  // Exact match first.
  for (const entry of catalog) {
    if (entry.connectorId !== connectorId) continue;
    if (revision > 0 && entry.revision !== revision) continue;
    return entry;
  }
  if (revision > 0) return undefined;
  // Fall back to any entry with the same connectorId (the fetcher is
  // tolerant of `revision === 0` meaning "any revision on file").
  for (const entry of catalog) {
    if (entry.connectorId === connectorId) return entry;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch the connector config / secret / test result view for the
 * given `(connectorId, revision)`. Returns a discriminated result
 * the renderer can map onto a screen state. **Never throws** —
 * transport errors collapse into `{ kind: 'error', ... }`.
 */
export async function fetchConnectorConfig(
  input: ConnectorFetcherInput,
): Promise<ConnectorFetchResult> {
  const connectorId = input.connectorId;
  const revision = input.revision ?? 0;

  if (connectorId.length === 0) {
    return {
      kind: 'empty',
      connectorId,
      message: 'Pick a connector to open its configuration pane.',
    };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 4000;
  const nowMs = Date.now();

  if (!input.jsonBaseUrl) {
    // No platform API configured — fall back to the in-process
    // catalog (tests only; production always configures `jsonBaseUrl`).
    const entry = pickCatalogEntry(input, connectorId, revision);
    if (entry) {
      return buildOkFromCatalog(entry);
    }
    return {
      kind: 'not-found',
      connectorId,
      message: `Connector '${connectorId}' has no revisions registered on the shell yet.`,
    };
  }
  if (!input.adminToken) {
    return {
      kind: 'unauthorized',
      connectorId,
      message: 'Admin bearer token is not configured.',
    };
  }

  let url: URL;
  try {
    const path = revision > 0
      ? `/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/revisions/${encodeURIComponent(String(revision))}`
      : `/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/revisions/latest`;
    url = new URL(path, input.jsonBaseUrl);
  } catch {
    return {
      kind: 'error',
      connectorId,
      message: 'Invalid platform JSON API base URL.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.adminToken}`,
        accept: 'application/json',
        'x-correlation-id': `p6-04-${nowMs.toString(36)}`,
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'unauthorized',
        connectorId,
        message: `Platform rejected the admin token (HTTP ${res.status}).`,
      };
    }
    if (res.status === 404) {
      return {
        kind: 'not-found',
        connectorId,
        message: `Connector '${connectorId}' revision '${revision > 0 ? String(revision) : 'latest'}' is not on the server.`,
      };
    }
    if (!res.ok) {
      const body = sanitizeUpstreamErrorBody(await res.text().catch(() => ''));
      return {
        kind: 'error',
        connectorId,
        message: `Platform returned HTTP ${res.status}${body ? `: ${body}` : ''}`,
      };
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        kind: 'error',
        connectorId,
        message: 'Platform returned non-JSON for the connector-revisions endpoint.',
      };
    }
    return parseFetchPayload(parsed, connectorId, revision);
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    return {
      kind: 'error',
      connectorId,
      message: aborted
        ? `Timed out after ${timeoutMs}ms waiting for the platform.`
        : safeTransportErrorText('Network error contacting the platform'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Catalog → ok result
// ---------------------------------------------------------------------------

function buildOkFromCatalog(entry: ConnectorRevisionCatalogEntry): ConnectorFetchResult {
  const revisionView: ConnectorRevisionView = buildConnectorConfigRevisionView({
    revision: {
      connectorId: entry.connectorId,
      revision: entry.revision,
      adapter: entry.adapter,
      endpoint: entry.endpoint,
      capabilities: entry.capabilities,
      state: entry.state,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    secretSlots: entry.secretSlots,
  });
  const testResultView = buildConnectorTestResultView(
    entry.connectorId,
    entry.revision,
    entry.testResult,
  );
  return {
    kind: 'ok',
    connectorId: entry.connectorId,
    revision: entry.revision,
    revisionView,
    testResult: testResultView,
    rotateState: entry.rotateState,
    secretSlotViews: revisionView.secretSlots,
    revisionRow: {
      connectorId: entry.connectorId,
      revision: entry.revision,
      adapter: entry.adapter,
      endpoint: entry.endpoint,
      capabilities: entry.capabilities,
      state: entry.state,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    revisionLabel: `#${entry.revision}`,
  };
}

// ---------------------------------------------------------------------------
// Wire → ok result
// ---------------------------------------------------------------------------

function parseFetchPayload(
  raw: unknown,
  fallbackConnectorId: string,
  fallbackRevision: number,
): ConnectorFetchResult {
  if (!raw || typeof raw !== 'object') {
    return {
      kind: 'error',
      connectorId: fallbackConnectorId,
      message: 'Platform returned an unexpected payload shape (not an object).',
    };
  }
  const obj = raw as Record<string, unknown>;
  const connectorId = typeof obj.connectorId === 'string' ? obj.connectorId : fallbackConnectorId;
  const revision =
    typeof obj.revision === 'number' && Number.isFinite(obj.revision) && obj.revision > 0
      ? obj.revision
      : fallbackRevision;
  if (
    fallbackRevision > 0 &&
    (connectorId !== fallbackConnectorId || revision !== fallbackRevision)
  ) {
    return {
      kind: 'not-found',
      connectorId: fallbackConnectorId,
      message: `Connector '${fallbackConnectorId}' revision '${fallbackRevision}' is not available.`,
    };
  }
  const adapter = typeof obj.adapter === 'string' ? obj.adapter : 'unknown';
  const endpoint = normaliseEndpoint(obj.endpoint as ConnectorEndpointDisplay | undefined);
  const capabilities = Array.isArray(obj.capabilities)
    ? obj.capabilities.filter((c): c is string => typeof c === 'string')
    : [];
  const state = normaliseState(obj.state as string | undefined);
  const createdAt = typeof obj.createdAt === 'string' ? obj.createdAt : '';
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : '';

  const rawSlots = Array.isArray(obj.secretSlots) ? obj.secretSlots : [];
  const secretSlots: ConnectorSecretSlotRow[] = rawSlots
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      name: typeof s.name === 'string' ? s.name : '',
      label: typeof s.label === 'string' ? s.label : (typeof s.name === 'string' ? s.name : ''),
      hasValue: s.hasValue === true,
      rotatedAt: typeof s.rotatedAt === 'string' ? s.rotatedAt : null,
    }));

  const rawTest = (obj.testResult ?? {}) as Record<string, unknown>;
  const testResult: ConnectorTestResult = {
    kind: normaliseKind(rawTest.kind as string | undefined),
    message: typeof rawTest.message === 'string' ? rawTest.message : '',
    testedAt: typeof rawTest.testedAt === 'string' ? rawTest.testedAt : null,
  };

  const rawRotate = (obj.rotateState ?? {}) as Record<string, unknown>;
  const rotateState = normaliseRotateState(rawRotate.state as string | undefined);

  return buildOkFromCatalog({
    connectorId,
    revision,
    adapter,
    endpoint,
    capabilities,
    state,
    createdAt,
    updatedAt,
    secretSlots,
    testResult,
    rotateState,
  });
}

// ---------------------------------------------------------------------------
// Standalone helpers re-exported for tests
// ---------------------------------------------------------------------------

export const __test = {
  normaliseEndpoint,
  normaliseState,
  normaliseKind,
  normaliseRotateState,
  pickCatalogEntry,
  buildOkFromCatalog,
  parseFetchPayload,
  /** Sanitized badge helper kept in scope so the renderer can mirror it. */
  connectorStateBadge,
  connectorStateLabel,
  connectorTestBadge,
  connectorTestLabel,
  /** Rotation-confirmation builder (UI uses this when a slot is selected). */
  buildSecretRotationConfirm,
  /** Per-revision rotate-secret guard (re-exported for the renderer). */
  canRotateSecret,
  /** Derive rotate-secret sub-state from a connector state. */
  deriveRotateSecretState,
  /** Mark `ConnectorConfigView` as imported to keep the public surface stable. */
  buildConnectorConfigRevisionView,
};

/** Type guard for the renderer / tests. */
export function isOkResult(
  f: ConnectorFetchResult,
): f is ConnectorFetchResult & { kind: 'ok' } {
  return f.kind === 'ok';
}
