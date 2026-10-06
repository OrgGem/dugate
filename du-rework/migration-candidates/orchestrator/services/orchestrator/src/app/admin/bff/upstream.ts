/**
 * Shared upstream plumbing for the Admin BFF (AWEB-02/04/05).
 *
 * Extracted from handle.ts so profile routes (bff/profiles.ts) reuse the exact
 * same credential selection, tenant fence helpers, timeout, problem mapping and
 * no-store response writers — one behaviour, no second copy.
 */
import type { ServerResponse } from 'node:http';
import { createLogger } from '@du/observability';
import type { ScopedPrincipal } from './types';
import {
  JSON_CONTENT_TYPE,
  PROBLEM_CONTENT_TYPE,
  boundedMessage,
  problemBody,
  upstreamProblem,
} from './envelope';

const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'admin-bff' } });

export const UPSTREAM_TIMEOUT_MS = 5000;

export interface BffRuntimeConfig {
  /** Platform admin bearer — used ONLY for platform-principal sessions. */
  adminToken?: string;
  /** Per-tenant admin bearers (ServerConfig.tenantAdminTokens shape). */
  tenantAdminTokens?: Record<string, string>;
  /** Platform JSON API base URL (`http://127.0.0.1:3000`). */
  jsonBaseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface UpstreamCallOptions {
  method: 'GET' | 'POST' | 'PUT';
  credential: string;
  correlationId: string;
  jsonBody?: string;
  idempotencyKey?: string;
}

/**
 * ServerConfig.tenantAdminTokens maps bearer token → tenant id; the BFF needs
 * the reverse for a session's stored tenant. Own-entries scan only, mirroring
 * resolveAdminPrincipal's prototype-safety rule.
 */
export function credentialForTenant(
  map: Record<string, string> | undefined,
  tenantId: string,
): string | undefined {
  for (const [token, mappedTenant] of Object.entries(map ?? {})) {
    if (mappedTenant === tenantId && token.length > 0) return token;
  }
  return undefined;
}

/** The session principal in the shared RBAC shape. */
export function rbacPrincipal(
  principal: ScopedPrincipal,
): { role: 'platform' } | { role: 'tenant_operator'; tenantId: string } {
  return principal.kind === 'platform'
    ? { role: 'platform' }
    : { role: 'tenant_operator', tenantId: principal.tenantId };
}

/** Credential for this session's principal; null = fail closed. */
export function credentialFor(principal: ScopedPrincipal, runtime: BffRuntimeConfig): string | null {
  const value =
    principal.kind === 'platform'
      ? runtime.adminToken
      : credentialForTenant(runtime.tenantAdminTokens, principal.tenantId);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Decode one URL path segment; null for empty/oversized/embedded-slash values
 * and for dot segments (`F-AW05-1`): a decoded `.`/`..` must 404 BEFORE any
 * upstream call — otherwise URL normalisation could shift the request onto a
 * different route instead of denying it.
 */
export function decodePathSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > 128 || decoded.includes('/') || decoded.includes('\\')) {
    return null;
  }
  if (decoded === '.' || decoded === '..') return null;
  return decoded;
}

export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export async function callUpstream(
  runtime: BffRuntimeConfig,
  url: URL,
  options: UpstreamCallOptions,
): Promise<Response> {
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.credential}`,
    accept: 'application/json',
    'x-correlation-id': options.correlationId,
  };
  if (options.jsonBody !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
  try {
    return await fetchImpl(url.toString(), {
      method: options.method,
      headers,
      ...(options.jsonBody !== undefined ? { body: options.jsonBody } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn('[admin-bff] upstream call failed', {
      correlationId: options.correlationId,
      method: options.method,
      errorClass: err instanceof Error ? err.name : typeof err,
    });
    throw new UpstreamUnavailableError();
  }
}

/** 503 problem — thrown when the upstream call itself fails. */
export class UpstreamUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'UPSTREAM_UNAVAILABLE';
  constructor() {
    super('the admin API is unavailable');
    this.name = 'UpstreamUnavailableError';
  }
}

export async function relayUpstream(
  res: ServerResponse,
  response: Response,
  correlationId: string,
  opts: { wrapInData?: boolean } = {},
): Promise<void> {
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const problem = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as {
      code?: unknown;
      errors?: unknown;
    };
    const body = upstreamProblem(response.status, problem.code, problem.errors, correlationId);
    res.setHeader('content-type', PROBLEM_CONTENT_TYPE);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-correlation-id', correlationId);
    res.statusCode = body.status;
    res.end(JSON.stringify(body));
    return;
  }
  if (parsed === null) {
    logger.warn('[admin-bff] upstream returned a non-JSON success body', {
      correlationId,
      status: response.status,
    });
    writeProblem(res, 502, 'UPSTREAM_ERROR', 'the admin API returned an unreadable response', correlationId);
    return;
  }
  writeJson(res, response.status, opts.wrapInData === true ? { data: parsed } : parsed, correlationId);
}

export function writeJson(res: ServerResponse, status: number, body: unknown, correlationId: string): void {
  res.statusCode = status;
  res.setHeader('content-type', JSON_CONTENT_TYPE);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-correlation-id', correlationId);
  res.end(JSON.stringify(body));
}

export function writeProblem(
  res: ServerResponse,
  status: number,
  code: string,
  title: string,
  correlationId: string,
): void {
  const body = problemBody(status, code, boundedMessage(title) ?? code, correlationId);
  res.statusCode = body.status;
  res.setHeader('content-type', PROBLEM_CONTENT_TYPE);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-correlation-id', correlationId);
  res.end(JSON.stringify(body));
}

export { boundedMessage, problemBody };
