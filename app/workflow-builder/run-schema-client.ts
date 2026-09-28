// app/workflow-builder/run-schema-client.ts
// Pure typed request/result helpers for the Workflow Builder Run UI (Fix 5
// browser-to-route contract). Extracted from `page.tsx` so the contract can
// be unit-tested without rendering the Next.js client page (jsdom + Next.js
// app-router mocks are fragile and out of this lane's scope).
//
// The route contract is owned by `app/api/v1/docs/workflows/schema/route.ts`
// and already covered by `tests/workflow-builder/schema-route.test.ts`. This
// module is the browser-side mirror of that contract:
//
//   POST /api/v1/docs/workflows/schema
//     multipart/form-data: schemaSlug, input (JSON string, optional),
//                          files[] (optional)
//
//   202 + Operation-Location → navigation target `/operations/<id>`
//   400/404 → ProblemDetails { title, status, detail }
//   network error → "Lỗi kết nối"

export const RUN_SCHEMA_ENDPOINT = '/api/v1/docs/workflows/schema';

export interface RunSchemaInputProperty {
  required?: boolean;
  label?: string;
}

export interface RunSchemaValidationError {
  /** Field key in the input_schema map. */
  field: string;
  /** Human-readable label (falls back to the field key). */
  label: string;
}

export interface RunSchemaAccepted {
  ok: true;
  status: 202;
  operationId: string;
  /** URL path the caller should navigate to. */
  operationUrl: string;
}

export interface RunSchemaRejected {
  ok: false;
  status: number;
  detail: string;
  title?: string;
}

export interface RunSchemaNetworkError {
  ok: false;
  status: 0;
  detail: 'Lỗi kết nối';
}

export type RunSchemaResult =
  | RunSchemaAccepted
  | RunSchemaRejected
  | RunSchemaNetworkError;

export interface RunSchemaSubmitRequest {
  schemaSlug: string;
  inputs: Record<string, unknown>;
  files?: File[];
}

/**
 * Validate that all required fields are present in `inputs` (non-empty,
 * non-null). Returns the first missing field, or null when valid. The caller
 * (the React form) is responsible for surfacing the error to the user.
 */
export function findMissingRequiredField(
  inputs: Record<string, unknown>,
  properties: Record<string, RunSchemaInputProperty> | undefined,
): RunSchemaValidationError | null {
  if (!properties) return null;
  for (const [key, prop] of Object.entries(properties)) {
    if (!prop?.required) continue;
    const value = inputs[key];
    if (value === undefined || value === null || value === '') {
      return { field: key, label: prop.label ?? key };
    }
  }
  return null;
}

/**
 * Compose the multipart/form-data body for `POST /api/v1/docs/workflows/schema`.
 * Pure: no side effects, no fetch. The route contract requires:
 *   - `schemaSlug` (always)
 *   - `input` (JSON string) when `inputs` is non-empty
 *   - `files[]` per file (zero or more)
 */
export function buildRunSchemaFormData(req: RunSchemaSubmitRequest): FormData {
  const form = new FormData();
  form.append('schemaSlug', req.schemaSlug);
  if (Object.keys(req.inputs).length > 0) {
    form.append('input', JSON.stringify(req.inputs));
  }
  for (const file of req.files ?? []) {
    form.append('files[]', file);
  }
  return form;
}

/**
 * Extract the operation id from a 202 response body of the shape
 * `{ name: "operations/<id>", done, metadata }` (the schema route's
 * accepted-enqueue response shape). Returns null if the body does not
 * include a recognizable operation name.
 */
export function extractOperationId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const name = (body as { name?: unknown }).name;
  if (typeof name !== 'string') return null;
  const match = /^operations\/(.+)$/.exec(name);
  return match ? match[1] : null;
}

/**
 * Extract a human-readable error detail from a ProblemDetails-shaped
 * response body `{ title, status, detail, type }`. Falls back to the
 * supplied fallback (or a generic message) when the body is missing or
 * lacks a `detail` field.
 */
export function extractErrorDetail(body: unknown, fallback = 'Chạy thất bại'): string {
  if (!body || typeof body !== 'object') return fallback;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail.length > 0) return detail;
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string' && error.length > 0) return error;
  return fallback;
}

export function extractErrorTitle(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const title = (body as { title?: unknown }).title;
  return typeof title === 'string' ? title : undefined;
}

export function extractErrorStatus(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const status = (body as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Minimal `fetch`-compatible signature used by `submitRunSchema`. Defined as
 * an alias of the global `typeof fetch` so the helper is callable under
 * jest's node environment (Node 20+ provides global `fetch`) and testable
 * with a pure mock.
 */
export type RunSchemaFetcher = typeof fetch;

/**
 * Outcome shape returned by `submitRunSchema`. The caller (page.tsx) maps
 * each variant to the same UX outcomes already in place: success →
 * toast + navigate; rejection / network error → toast with a localized
 * message. The page does not need to know about HTTP internals.
 */
export type RunSchemaOutcome =
  | RunSchemaAccepted
  | RunSchemaRejected
  | RunSchemaNetworkError
  | RunSchemaUnrecognized;

/**
 * 202 was returned but the response body does not include an operation id.
 * This is a recoverable condition (the user can retry) and is surfaced as
 * a distinct outcome so the UI can show a retry-friendly message instead
 * of the generic "Lỗi kết nối".
 */
export interface RunSchemaUnrecognized {
  ok: false;
  status: 202;
  detail: 'Response thiếu operation id';
  /** The raw body the route returned, for diagnostics only. */
  body: unknown;
}

/**
 * Parse the body of an HTTP response. `Response.json()` rejects on
 * non-JSON / malformed payloads; this helper normalizes that rejection
 * into a `null` body so the caller can decide what to surface. Mirrors
 * what `page.tsx` does today (it does not catch `res.json()` rejections,
 * so a malformed body currently throws to the surrounding try/catch and
 * is labeled "Lỗi kết nối" — `submitRunSchema` upgrades that into an
 * explicit outcome).
 */
async function safeParseJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Submit the Run-schema request and reduce the response to a typed
 * `RunSchemaOutcome`. This is the testable boundary that the W30-CC
 * packet called out as missing for the network/rejected-fetch path.
 *
 * The default `fetcher` parameter is the global `fetch`. Tests inject a
 * pure mock to exercise the rejected-fetch / malformed-body / 202-no-id
 * paths without real network I/O.
 *
 * Contract (mirrors `app/api/v1/docs/workflows/schema/route.ts`):
 *   - 202 with body { name: "operations/<id>" } → RunSchemaAccepted
 *   - 202 with body missing a parseable operation id → RunSchemaUnrecognized
 *     (recoverable: caller may retry)
 *   - non-2xx with ProblemDetails body → RunSchemaRejected with `detail`
 *   - non-2xx with malformed/non-JSON body → RunSchemaRejected with the
 *     status and a generic detail
 *   - `fetcher` rejects (network error, abort, CORS, etc.) → RunSchemaNetworkError
 */
export async function submitRunSchema(
  req: RunSchemaSubmitRequest,
  fetcher: RunSchemaFetcher = fetch,
): Promise<RunSchemaOutcome> {
  const form = buildRunSchemaFormData(req);
  let response: Response;
  try {
    response = await fetcher(RUN_SCHEMA_ENDPOINT, { method: 'POST', body: form });
  } catch {
    return { ok: false, status: 0, detail: 'Lỗi kết nối' };
  }

  // 2xx (route returns 202 on accept) → success path.
  if (response.ok) {
    const body = await safeParseJson(response);
    const operationId = extractOperationId(body);
    if (operationId) {
      return {
        ok: true,
        status: 202,
        operationId,
        operationUrl: `/operations/${operationId}`,
      };
    }
    return {
      ok: false,
      status: 202,
      detail: 'Response thiếu operation id',
      body,
    };
  }

  // Non-2xx → rejection.
  const body = await safeParseJson(response);
  return {
    ok: false,
    status: response.status,
    detail: extractErrorDetail(body, `HTTP ${response.status}`),
    title: extractErrorTitle(body),
  };
}
