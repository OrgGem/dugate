/**
 * P6-02 Business section data seam.
 *
 * The rendered shell learns about business versions by calling the
 * platform's JSON API. As of W40-O5 the platform exposes no
 * read-only business-versions GET route (only the per-version
 * `enable` / `activate` / `deactivate` PUTs in
 * `services/orchestrator/src/server.ts:704-748`). The fetcher seam
 * below is the single place the shell calls out — when Claude Code
 * lands `GET /api/v1/admin/businesses/:id/versions`, this is the
 * one wire-up to change.
 *
 * Pure HTTP, no DB, no Redis. `fetchImpl` is injectable so the test
 * harness can drive the response without booting the platform. The
 * function returns a discriminated `BusinessFetchResult` so the
 * renderer can map every transport-level outcome (200 / 401 / 404 /
 * 5xx / network) onto the existing four screen states
 * (loading / empty / error / denied / ready) without guessing.
 *
 * Strict TypeScript, zero `any`.
 */

import { sanitizeUpstreamErrorBody } from './upstream-error-body';
import type { BusinessVersionRow } from './business-view-models';
import type { BusinessStatus, WorkerHealth } from '@du/contracts';
import { safeTransportErrorText } from '../../http/errors';

// ---------------------------------------------------------------------------
// Wire shape (raw rows as the platform's GET would return them)
// ---------------------------------------------------------------------------

/**
 * Raw version row as it appears on the wire. The shape is a strict
 * superset of `BusinessVersionRow` from the view-model layer; the
 * fetcher normalises aliases (`state` → `status`,
 * `active` → `isActive`, `last_heartbeat` → `lastHeartbeatAt`,
 * `worker_health` → `workerHealth`) before handing rows to the
 * view-model builders.
 */
export interface BusinessVersionWireRow {
  businessId?: string;
  business_id?: string;
  version?: string;
  status?: string;
  state?: string;
  isActive?: boolean;
  active?: boolean;
  is_active?: boolean;
  registeredAt?: string;
  registered_at?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  digest?: string;
  queue?: string;
  lastHeartbeatAt?: string | null;
  last_heartbeat?: string | null;
  last_heartbeat_at?: string | null;
  workerHealth?: string | null;
  worker_health?: string | null;
  workerCount?: number;
  worker_count?: number;
}

// ---------------------------------------------------------------------------
// Fetcher input
// ---------------------------------------------------------------------------

/** Inputs the fetcher needs from the shell. */
export interface BusinessFetcherInput {
  /**
   * The business ID whose versions to load. The shell's `?businessId=…`
   * query string parameter (or, when unset, the first id in the
   * canonical list) drives this. Empty string = "show all businesses"
   * — the fetcher attempts a platform list, which is the GET Claude
   * Code needs to add.
   */
  businessId: string;
  /** Base URL of the orchestrator JSON API (e.g. `http://127.0.0.1:2023`). */
  jsonBaseUrl: string;
  /**
   * Admin bearer token. Sent verbatim as `Authorization: Bearer …`
   * so the platform's `assertAdminAuth` admits the request. The shell
   * reuses the same token it signs the cookie with — the cookie is
   * for the *browser* tier, the bearer is for the *server* tier.
   */
  adminToken: string;
  /**
   * Injected clock. Default = `Date.now`. Tests pass a fixed
   * value so `lastHeartbeatAt` age calculation is deterministic.
   */
  nowMs?: () => number;
  /**
   * Injected fetch. Default = global `fetch`. Tests pass a stub.
   * The signature mirrors the standard `fetch(input, init)` so a
   * test stub only needs to handle the two arguments the fetcher
   * actually passes.
   */
  fetchImpl?: typeof fetch;
  /**
   * Per-request timeout in ms. Default 4000 — the shell should not
   * hold an HTTP response open longer than the page-load budget.
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Fetcher result (discriminated union — drives the renderer's screen state)
// ---------------------------------------------------------------------------

export type BusinessFetchResult =
  | {
      kind: 'ok';
      businessId: string;
      rows: readonly BusinessVersionRow[];
      /**
       * The active version pointer, if the platform reported one.
       * `null` when the platform has no active version for this
       * business (e.g. all versions draining or none enabled).
       */
      activeVersion: string | null;
    }
  | {
      kind: 'unauthorized';
      businessId: string;
      message: string;
    }
  | {
      kind: 'not-found';
      businessId: string;
      message: string;
    }
  | {
      kind: 'error';
      businessId: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normaliseStatus(raw: string | undefined): BusinessStatus {
  switch (raw) {
    case 'ENABLED':
    case 'DRAINING':
    case 'REGISTERED_DISABLED':
    case 'RETIRED':
      return raw;
    default:
      // Unknown status — coerce to REGISTERED_DISABLED so the
      // view-model can still display a row, but mark the original
      // by passing through `digest` if the caller provided it. The
      // platform's contracts freeze the four states; anything else
      // is a wire bug we surface by failing closed at row-build.
      return 'REGISTERED_DISABLED';
  }
}

function normaliseWorkerHealth(raw: string | null | undefined): WorkerHealth | null {
  if (raw === 'HEALTHY' || raw === 'DEGRADED' || raw === 'OFFLINE') {
    return raw;
  }
  return null;
}

function normaliseRow(raw: BusinessVersionWireRow, fallbackBusinessId: string): BusinessVersionRow {
  const businessId = raw.businessId ?? raw.business_id ?? fallbackBusinessId;
  const version = raw.version ?? '';
  const status = normaliseStatus(raw.status ?? raw.state);
  const isActive = raw.isActive ?? raw.active ?? raw.is_active ?? false;
  const registeredAt = raw.registeredAt ?? raw.registered_at ?? raw.createdAt ?? raw.created_at ?? '';
  const lastHeartbeatAt =
    raw.lastHeartbeatAt ?? raw.last_heartbeat ?? raw.last_heartbeat_at ?? null;
  const workerHealth = normaliseWorkerHealth(raw.workerHealth ?? raw.worker_health ?? null);
  const workerCount = raw.workerCount ?? raw.worker_count;
  return {
    businessId,
    version,
    status,
    isActive,
    registeredAt,
    digest: raw.digest,
    queue: raw.queue,
    lastHeartbeatAt,
    workerHealth,
    workerCount,
  };
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch business versions for the given businessId from the
 * orchestrator JSON API. Returns a discriminated result the renderer
 * can map onto a screen state. **Never throws** — transport errors
 * collapse into `{ kind: 'error', ... }` so the shell stays
 * fail-closed at the HTTP layer.
 *
 * When `businessId === ''`, the fetcher attempts the platform's
 * "list all businesses" route. The current platform has no such
 * route; the fetcher returns `kind: 'not-found'` until Claude Code
 * lands `GET /api/v1/admin/businesses`.
 */
export async function fetchBusinessVersions(
  input: BusinessFetcherInput,
): Promise<BusinessFetchResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const now = input.nowMs ? input.nowMs() : Date.now();
  const timeoutMs = input.timeoutMs ?? 4000;

  if (!input.jsonBaseUrl) {
    return {
      kind: 'error',
      businessId: input.businessId,
      message: 'Platform JSON API base URL is not configured.',
    };
  }
  if (!input.adminToken) {
    return {
      kind: 'unauthorized',
      businessId: input.businessId,
      message: 'Admin bearer token is not configured.',
    };
  }

  // Build URL. When the platform lands the per-id detail route, this
  // is the wire-up point: `GET /api/v1/admin/businesses/:id/versions`
  // returns a `{ businessId, activeVersion, rows: [...] }` payload
  // (or `404` when the business is unknown). The empty-id list
  // route is the second wire-up when it lands.
  let url: URL;
  try {
    const path =
      input.businessId.length > 0
        ? `/api/v1/admin/businesses/${encodeURIComponent(input.businessId)}/versions`
        : `/api/v1/admin/businesses`;
    url = new URL(path, input.jsonBaseUrl);
  } catch {
    return {
      kind: 'error',
      businessId: input.businessId,
      message: 'Invalid platform JSON API base URL.',
    };
  }

  // AbortController for the timeout. The shell never holds the page
  // open longer than `timeoutMs`.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${input.adminToken}`,
        accept: 'application/json',
        'x-correlation-id': `p6-02-${now.toString(36)}`,
      },
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return {
        kind: 'unauthorized',
        businessId: input.businessId,
        message: `Platform rejected the admin token (HTTP ${res.status}).`,
      };
    }
    if (res.status === 404) {
      return {
        kind: 'not-found',
        businessId: input.businessId,
        message:
          input.businessId.length > 0
            ? `Business '${input.businessId}' is not registered on the platform.`
            : 'Platform does not expose a business list endpoint (GET /api/v1/admin/businesses).',
      };
    }
    if (!res.ok) {
      const body = sanitizeUpstreamErrorBody(await res.text().catch(() => ''));
      return {
        kind: 'error',
        businessId: input.businessId,
        message: `Platform returned HTTP ${res.status}${body ? `: ${body}` : ''}`,
      };
    }

    // 2xx — parse. We accept both the documented `{ businessId, activeVersion, rows: [...] }`
    // envelope and the bare array form so a stub or older platform can satisfy the seam.
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        kind: 'error',
        businessId: input.businessId,
        message: 'Platform returned non-JSON for the business-versions endpoint.',
      };
    }
    return parseFetchPayload(parsed, input.businessId);
  } catch (err) {
    const aborted =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    return {
      kind: 'error',
      businessId: input.businessId,
      message: aborted
        ? `Timed out after ${timeoutMs}ms waiting for the platform.`
        : safeTransportErrorText('Network error contacting the platform'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseFetchPayload(
  raw: unknown,
  fallbackBusinessId: string,
): BusinessFetchResult {
  if (Array.isArray(raw)) {
    // Bare array form (e.g. stub or future list endpoint).
    const rows: BusinessVersionRow[] = [];
    for (const item of raw) {
      if (item && typeof item === 'object') {
        rows.push(normaliseRow(item as BusinessVersionWireRow, fallbackBusinessId));
      }
    }
    const active = rows.find((r) => r.isActive === true)?.version ?? null;
    return {
      kind: 'ok',
      businessId: fallbackBusinessId,
      rows,
      activeVersion: active,
    };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const businessId =
      typeof obj.businessId === 'string'
        ? obj.businessId
        : typeof obj.business_id === 'string'
          ? obj.business_id
          : fallbackBusinessId;
    const activeVersionRaw =
      obj.activeVersion ?? obj.active_version ?? obj.active;
    const activeVersion =
      typeof activeVersionRaw === 'string' && activeVersionRaw.length > 0
        ? activeVersionRaw
        : null;
    const rawRows = obj.rows ?? obj.versions ?? obj.items;
    const rows: BusinessVersionRow[] = [];
    if (Array.isArray(rawRows)) {
      for (const item of rawRows) {
        if (item && typeof item === 'object') {
          rows.push(normaliseRow(item as BusinessVersionWireRow, businessId));
        }
      }
    }
    return {
      kind: 'ok',
      businessId,
      rows,
      activeVersion,
    };
  }
  return {
    kind: 'error',
    businessId: fallbackBusinessId,
    message: 'Platform returned an unexpected payload shape (not an object or array).',
  };
}
