/**
 * P6-05 API key section data seam.
 *
 * Pure HTTP fetcher for the API key create / copy-once / revoke /
 * assignment pane. Discriminated `ApiKeyFetchResult` drives the
 * renderer.
 *
 * Design (mirrors `connector-section-data.ts`):
 * - When `?keyId=…` is empty AND the in-process `keyCatalog` has
 *   no entries, the fetcher returns `kind: 'empty'` (the renderer
 *   shows "No API keys yet").
 * - When `?keyId=…` is empty but the catalog has entries, the
 *   fetcher returns `kind: 'ok'` with the list-only envelope
 *   (`rows[]`, `grantsByKeyId` empty, `createCopyOnce` null).
 * - When `?keyId=…` is non-empty and a row is found, the fetcher
 *   returns `kind: 'ok'` with the row, its grants, and any
 *   pending `createCopyOnce` window the operator has not yet
 *   acknowledged.
 * - When `jsonBaseUrl` is set, the fetcher GETs the orchestrator's
 *   `/api/v1/admin/api-keys[/<keyId>]` and parses the envelope.
 * - 401/403 → `unauthorized`. 404 → `not-found`. Other transport
 *   failures → `error`. Network/timeout → `error`.
 *
 * Hard rule: the raw API key value is NEVER carried by the wire or
 * the fetcher result. The wire shape carries only `maskedHint` and
 * an explicit `createCopyOnce` window (with the raw value visible
 * only to the operator who triggered the create) — once the
 * operator acknowledges, the renderer drops the window and only the
 * masked hint is ever shown.
 *
 * No DB, no Redis. `fetchImpl` is injectable. Strict TypeScript,
 * zero `any`.
 */

import { sanitizeUpstreamErrorBody } from './upstream-error-body';
import type {
  ApiKeyAssignmentRow,
  ApiKeyCreateView,
  ApiKeyGrantRow,
  ApiKeyListRow,
  ApiKeyRow,
  ApiKeyStatus,
} from './api-key-view-models';
import {
  buildApiKeyCreateView,
  buildApiKeyListView,
} from './api-key-view-models';
import { safeTransportErrorText } from '../../http/errors';

// ---------------------------------------------------------------------------
// Wire shape (raw rows as the platform's GET would return them)
// ---------------------------------------------------------------------------

/**
 * Raw API key row on the wire. The server has already discarded
 * the raw key value — only the masked hint plus metadata is
 * present.
 */
export interface ApiKeyWireRow {
  id?: string;
  tenantId?: string;
  maskedHint?: string;
  prefix?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string | null;
  label?: string | null;
  revokedAt?: string | null;
}

/**
 * Raw grant row on the wire. Display-only projection; the server
 * remains the authorization authority.
 */
export interface ApiKeyGrantWireRow {
  businessId?: string;
  businessVersion?: string;
  action?: string;
  grantedAt?: string;
}

/**
 * Raw copy-once window on the wire. The server returns this
 * immediately after a create; the operator must acknowledge it
 * before navigating away or the next render is masked-only.
 *
 * The `rawKey` field IS the raw key value. It is the ONLY place
 * this value ever appears on the wire. The renderer projects it
 * once and the client MUST drop it on acknowledgement — it never
 * persists into any other view model.
 */
export interface ApiKeyCopyOnceWireRow {
  id?: string;
  tenantId?: string;
  prefix?: string;
  label?: string | null;
  createdAt?: string;
  rawKey?: string;
}

/**
 * Top-level envelope the platform returns from
 * `GET /api/v1/admin/api-keys` and `GET /api/v1/admin/api-keys/<keyId>`.
 *
 * W-ADMUX02-EXT-1: the list route now answers the shared admin page envelope,
 * so `items` + the four paging fields are the contract; `rows` remains typed
 * for tolerance of a pre-extension build.
 */
export interface ApiKeyListWireEnvelope {
  items?: ApiKeyWireRow[];
  /** Legacy key (pre W-ADMUX02-EXT-1); still accepted on read. */
  rows?: ApiKeyWireRow[];
  grants?: ApiKeyGrantWireRow[];
  /** Optional create copy-once window when the most recent create is unacknowledged. */
  createCopyOnce?: ApiKeyCopyOnceWireRow | null;
  nextCursor?: string | null;
  prevCursor?: string | null;
  total?: number;
  limit?: number;
}

/**
 * Headless fixture input — used by tests when no platform JSON API
 * is wired. Mirrors the envelope but stays fully offline.
 */
export interface ApiKeyCatalogEntry {
  id: string;
  tenantId: string;
  maskedHint: string;
  prefix: string;
  status: ApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  label: string | null;
  revokedAt: string | null;
  grants: ApiKeyGrantRow[];
}

export interface ApiKeyCatalog {
  entries: readonly ApiKeyCatalogEntry[];
  /** Optional pending create copy-once window (test only). */
  pendingCreateCopyOnce?: ApiKeyCreateView | null;
}

// ---------------------------------------------------------------------------
// Fetcher input
// ---------------------------------------------------------------------------

/** Inputs the fetcher needs from the shell. */
export interface ApiKeyFetcherInput {
  /**
   * The API key id whose grants to load. Empty → list pane
   * (no detail row).
   */
  keyId: string;
  /** Base URL of the orchestrator JSON API. */
  jsonBaseUrl: string;
  /** Admin bearer token (sent verbatim as `Authorization: Bearer …`). */
  adminToken: string;
  /** Optional in-process catalog (test-only). */
  manifestCatalog?: ApiKeyCatalog;
  /** Injected fetch. Default = global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 4000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Fetcher result (discriminated union — drives the renderer's screen state)
// ---------------------------------------------------------------------------

export interface ApiKeyListOkResult {
  kind: 'ok';
  rows: readonly ApiKeyListRow[];
  total: number;
  /** The selected key's detail row, when `keyId` is non-empty and matches. */
  selected: ApiKeyListRow | null;
  /** Grants attached to the selected key, when present. */
  grants: readonly ApiKeyAssignmentRow[];
  /** Pending copy-once window for the most recent create (if any). */
  createCopyOnce: ApiKeyCreateView | null;
  /** The masked hint the picker / list should highlight (driven by `keyId`). */
  selectedKeyId: string;
}

export type ApiKeyFetchResult =
  | ApiKeyListOkResult
  | { kind: 'empty'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'not-found'; keyId: string; message: string }
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseStatus(raw: string | undefined): ApiKeyStatus {
  switch (raw) {
    case 'ACTIVE':
    case 'REVOKING':
    case 'REVOKED':
      return raw;
    default:
      return 'ACTIVE';
  }
}

function pickCatalog(
  input: ApiKeyFetcherInput,
): ApiKeyCatalog | undefined {
  return input.manifestCatalog;
}

function rowToWireRow(row: ApiKeyCatalogEntry): ApiKeyRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    maskedHint: row.maskedHint,
    prefix: row.prefix,
    status: row.status,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    label: row.label,
    revokedAt: row.revokedAt,
  };
}

function grantToWireRow(g: ApiKeyGrantRow): ApiKeyGrantWireRow {
  return {
    businessId: g.businessId,
    businessVersion: g.businessVersion,
    action: g.action,
    grantedAt: g.grantedAt,
  };
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch the API key list (and optional selected key + grants) for
 * the shell. Returns a discriminated result the renderer can map
 * onto a screen state. **Never throws** — transport errors collapse
 * into `{ kind: 'error', ... }`.
 */
export async function fetchApiKeys(
  input: ApiKeyFetcherInput,
): Promise<ApiKeyFetchResult> {
  const keyId = input.keyId;
  const catalog = pickCatalog(input);

  // Test / offline path: prefer the in-process catalog when no
  // platform URL is configured. This is identical to the pattern in
  // `profile-section-data` / `connector-section-data`.
  if (!input.jsonBaseUrl) {
    if (!catalog || catalog.entries.length === 0) {
      return {
        kind: 'empty',
        message:
          'No API keys are registered yet. Use POST /api/v1/admin/api-keys to issue the first one.',
      };
    }
    return buildOkFromCatalog(catalog, keyId);
  }

  if (!input.adminToken) {
    return {
      kind: 'unauthorized',
      message: 'Admin bearer token is not configured.',
    };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 4000;
  const nowMs = Date.now();

  let url: URL;
  try {
    const path =
      keyId.length > 0
        ? `/api/v1/admin/api-keys/${encodeURIComponent(keyId)}`
        : `/api/v1/admin/api-keys`;
    url = new URL(path, input.jsonBaseUrl);
  } catch {
    return {
      kind: 'error',
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
        'x-correlation-id': `p6-05-${nowMs.toString(36)}`,
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'unauthorized',
        message: `Platform rejected the admin token (HTTP ${res.status}).`,
      };
    }
    if (res.status === 404) {
      return {
        kind: 'not-found',
        keyId,
        message: `API key '${keyId}' is not on the server.`,
      };
    }
    if (!res.ok) {
      const body = sanitizeUpstreamErrorBody(await res.text().catch(() => ''));
      return {
        kind: 'error',
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
        message: 'Platform returned non-JSON for the api-keys endpoint.',
      };
    }
    return parseFetchPayload(parsed, keyId);
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    return {
      kind: 'error',
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

function buildOkFromCatalog(
  catalog: ApiKeyCatalog,
  keyId: string,
): ApiKeyFetchResult {
  const list = buildApiKeyListView(catalog.entries.map(rowToWireRow));
  let selected: ApiKeyListRow | null = null;
  let grants: readonly ApiKeyAssignmentRow[] = [];
  if (keyId.length > 0) {
    const hit = catalog.entries.find((e) => e.id === keyId);
    if (!hit) {
      return {
        kind: 'not-found',
        keyId,
        message: `API key '${keyId}' is not in the in-process catalog.`,
      };
    }
    selected = list.rows.find((r) => r.id === keyId) ?? null;
    grants = hit.grants.map((g) => ({
      businessId: g.businessId,
      businessVersion: g.businessVersion,
      action: g.action,
      grantedAt: g.grantedAt,
    }));
  }
  return {
    kind: 'ok',
    rows: list.rows,
    total: list.total,
    selected,
    grants,
    createCopyOnce: catalog.pendingCreateCopyOnce ?? null,
    selectedKeyId: keyId,
  };
}

// ---------------------------------------------------------------------------
// Wire → ok result
// ---------------------------------------------------------------------------

function parseFetchPayload(raw: unknown, keyId: string): ApiKeyFetchResult {
  if (!raw || typeof raw !== 'object') {
    return {
      kind: 'error',
      message: 'Platform returned an unexpected payload shape (not an object).',
    };
  }
  const obj = raw as Record<string, unknown>;

  // W-ADMUX02-EXT-1: the route answers the standard page envelope, whose
  // contract key is `items`. `rows` is still accepted so a shell pointed at an
  // older build degrades to a readable list instead of an empty pane.
  const pageRows = obj['items'] ?? obj['rows'];
  const rawRows = Array.isArray(pageRows) ? pageRows : [];
  const wireRows: ApiKeyRow[] = rawRows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      id: typeof r.id === 'string' ? r.id : '',
      tenantId: typeof r.tenantId === 'string' ? r.tenantId : '',
      maskedHint: typeof r.maskedHint === 'string' ? r.maskedHint : '',
      prefix: typeof r.prefix === 'string' ? r.prefix : '',
      status: normaliseStatus(r.status as string | undefined),
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
      lastUsedAt: typeof r.lastUsedAt === 'string' ? r.lastUsedAt : null,
      label: typeof r.label === 'string' ? r.label : null,
      revokedAt: typeof r.revokedAt === 'string' ? r.revokedAt : null,
    }));

  const list = buildApiKeyListView(wireRows);

  let selected: ApiKeyListRow | null = null;
  let grants: readonly ApiKeyAssignmentRow[] = [];
  if (keyId.length > 0) {
    const found = wireRows.find((r) => r.id === keyId);
    if (!found) {
      return {
        kind: 'not-found',
        keyId,
        message: `API key '${keyId}' is not on the server.`,
      };
    }
    selected = list.rows.find((r) => r.id === keyId) ?? null;
    const rawGrants = Array.isArray(obj.grants) ? obj.grants : [];
    grants = rawGrants
      .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
      .map((g) => ({
        businessId: typeof g.businessId === 'string' ? g.businessId : '',
        businessVersion:
          typeof g.businessVersion === 'string' ? g.businessVersion : '',
        action: typeof g.action === 'string' ? g.action : '',
        grantedAt: typeof g.grantedAt === 'string' ? g.grantedAt : '',
      }));
  }

  let createCopyOnce: ApiKeyCreateView | null = null;
  if (
    obj.createCopyOnce !== null &&
    obj.createCopyOnce !== undefined &&
    typeof obj.createCopyOnce === 'object'
  ) {
    const c = obj.createCopyOnce as Record<string, unknown>;
    const id = typeof c.id === 'string' ? c.id : '';
    const tenantId = typeof c.tenantId === 'string' ? c.tenantId : '';
    const prefix = typeof c.prefix === 'string' ? c.prefix : '';
    const label = typeof c.label === 'string' ? c.label : null;
    const createdAt = typeof c.createdAt === 'string' ? c.createdAt : '';
    const rawKey = typeof c.rawKey === 'string' ? c.rawKey : '';
    if (id.length > 0 && rawKey.length > 0) {
      createCopyOnce = buildApiKeyCreateView({
        id,
        tenantId,
        prefix,
        label,
        createdAt,
        rawKey,
      });
    }
  }

  return {
    kind: 'ok',
    rows: list.rows,
    total: list.total,
    selected,
    grants,
    createCopyOnce,
    selectedKeyId: keyId,
  };
}

// ---------------------------------------------------------------------------
// Standalone helpers re-exported for tests
// ---------------------------------------------------------------------------

export const __test = {
  normaliseStatus,
  buildOkFromCatalog,
  parseFetchPayload,
  /** The catalog projection helpers stay in scope so render tests can
   * assert the wire → view-model conversion. */
  rowToWireRow,
  grantToWireRow,
};

/** Type guard for the renderer / tests. */
export function isApiKeyOkResult(
  f: ApiKeyFetchResult,
): f is ApiKeyListOkResult {
  return f.kind === 'ok';
}
