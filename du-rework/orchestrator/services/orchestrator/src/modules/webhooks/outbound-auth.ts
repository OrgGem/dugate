/**
 * CB-03 (PROFILE-CALLBACK-20261006) — canonical outbound authentication helper
 * for the webhook dispatcher.
 *
 * The dispatcher owns the HTTP POST; this module owns WHAT authenticates it:
 *
 *   none                      → no auth headers (existing HMAC signature stays
 *                               independent and unchanged).
 *   configured_headers        → secret header(s) resolved from managed secret
 *                               REFERENCES at dispatch time (rotation applies),
 *                               e.g. `Authorization: Bearer <secret>` or
 *                               `X-API-Key: <secret>` with an optional validated
 *                               prefix.
 *   oauth2_client_credentials → OAuth2 token via `oauth2-client` (cached,
 *                               single-flight, renew-before-expiry) and
 *                               `Authorization: Bearer <access_token>`.
 *
 * Security invariants:
 * - No caller-controlled script/template execution; header names come from a
 *   small allowlist (`authorization`, `x-api-key`) and reserved signing /
 *   content / host / hop-by-hop / duplicate names are rejected.
 * - CRLF, control characters, unbounded names/values and conflicting
 *   Authorization headers fail closed with a typed, SECRET-FREE error.
 * - Secrets are resolved per attempt from a reference; values never enter
 *   URLs, error strings or logs. The helper never fetches the destination
 *   itself — it returns headers to the caller's already-pinned egress fetch
 *   (redirects remain disabled by that layer; the token client also sets
 *   `redirect: 'error'`).
 * - On an invalid-token 401 the OAuth2 entry is invalidated and ONE reacquire
 *   is allowed inside the delivery budget (`dispatchWithAuth`); generic 403
 *   and further 401s are returned unchanged. No unauthenticated fallback.
 */

import {
  OAuth2Error,
  OAuth2TokenClient,
  type OAuth2ClientCredentialsConfig,
  type OAuth2CacheScope,
  type OAuth2TokenClientOptions,
} from './oauth2-client';

/** Secret-header names this deployment accepts. */
export const OUTBOUND_SECRET_HEADER_ALLOWLIST: readonly string[] = ['authorization', 'x-api-key'];

/**
 * Names that never carry outbound auth: framing/content/host headers could
 * corrupt the request, the `x-du-*` trio is owned by the HMAC delivery
 * signature, and proxy auth must not be set by policy.
 */
export const OUTBOUND_RESERVED_HEADER_NAMES: readonly string[] = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
  'content-range',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'x-du-signature',
  'x-du-timestamp',
  'x-du-delivery-id',
];

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRINTABLE = /^[\x20-\x7e]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_HEADER_NAME_LENGTH = 64;
const MAX_HEADER_VALUE_LENGTH = 8192;
const MAX_SECRET_LENGTH = 4096;
const MAX_PREFIX_LENGTH = 64;
const MAX_SECRET_REF_LENGTH = 512;

export type OutboundAuthErrorCode =
  | 'AUTH_POLICY_INVALID'
  | 'SECRET_REF_INVALID'
  | 'SECRET_RESOLVE_FAILED'
  | 'SECRET_VALUE_INVALID'
  | 'HEADER_CONFLICT'
  | 'TOKEN_ACQUISITION_FAILED';

/** Typed, secret-free failure. Messages never echo header values or tokens. */
export class OutboundAuthError extends Error {
  public constructor(
    public readonly code: OutboundAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OutboundAuthError';
  }
}

/** Resolve a managed-secret reference to its value for THIS attempt only. */
export type OutboundSecretResolver = (secretRef: string) => Promise<string>;

export interface ConfiguredSecretHeader {
  /** Allowlisted header name (case-insensitive): authorization | x-api-key. */
  name: string;
  /** Opaque managed-secret reference (e.g. a Vault path); never the value. */
  secretRef: string;
  /** Optional validated prefix, e.g. `Bearer ` (trailing space significant). */
  prefix?: string;
}

export interface OutboundNonSecretHeader {
  name: string;
  value: string;
}

export type OutboundAuthPolicy =
  | { mode: 'none' }
  | { mode: 'configured_headers'; headers: readonly ConfiguredSecretHeader[] }
  | {
      mode: 'oauth2_client_credentials';
      config: OAuth2ClientCredentialsConfig;
      /** Nonsecret additional headers; may not include Authorization. */
      extraHeaders?: readonly OutboundNonSecretHeader[];
    };

export interface OutboundAuthDependencies {
  /** Required for configured_headers and oauth2 client secret references. */
  resolveSecret: OutboundSecretResolver;
  /** Cache scope for the OAuth2 token entry (tenant/profile/endpoint/generation). */
  cacheScope?: OAuth2CacheScope;
  /** Token client seams (tests inject fetch/clock). */
  oauth2Options?: OAuth2TokenClientOptions;
}

export interface OutboundAuthSession {
  readonly mode: OutboundAuthPolicy['mode'];
  /** Headers for one attempt. Resolves secrets/token at call time. */
  headersForAttempt(): Promise<Record<string, string>>;
  /** True only for OAuth2 sessions: a 401 may reacquire once. */
  readonly canReacquireOn401: boolean;
  /** Drop the exact cached token (401/rotation). No-op for other modes. */
  invalidate(): void;
}

function fail(code: OutboundAuthErrorCode, message: string): never {
  throw new OutboundAuthError(code, message);
}

/**
 * Validate one header name: RFC 7230 token, bounded, not reserved. `allowlist`
 * gates SECRET headers to the deployment's accepted names; non-secret extras
 * pass `undefined` and only have to avoid the reserved/Authorization clash.
 */
function validateHeaderName(name: unknown, allowlist?: readonly string[]): string {
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME_RE.test(name)) {
    fail('AUTH_POLICY_INVALID', 'outbound auth header name is invalid');
  }
  const lower = name.toLowerCase();
  if (OUTBOUND_RESERVED_HEADER_NAMES.includes(lower)) {
    fail('HEADER_CONFLICT', 'outbound auth header name is reserved by the delivery contract');
  }
  if (allowlist !== undefined && !allowlist.includes(lower)) {
    fail('AUTH_POLICY_INVALID', 'outbound auth header name is not in the allowed names');
  }
  return lower;
}

function validateHeaderValue(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_HEADER_VALUE_LENGTH
    || !PRINTABLE.test(value)
    || CONTROL.test(value)
  ) {
    fail('SECRET_VALUE_INVALID', label + ' is invalid');
  }
  return value;
}

function validateSecretRef(ref: unknown): string {
  if (
    typeof ref !== 'string'
    || ref.length < 1
    || ref.length > MAX_SECRET_REF_LENGTH
    || !PRINTABLE.test(ref)
    || CONTROL.test(ref)
  ) {
    fail('SECRET_REF_INVALID', 'outbound secret reference is invalid');
  }
  return ref;
}

function validatePrefix(prefix: unknown): string | undefined {
  if (prefix === undefined) return undefined;
  if (
    typeof prefix !== 'string'
    || prefix.length < 1
    || prefix.length > MAX_PREFIX_LENGTH
    || !PRINTABLE.test(prefix)
    || CONTROL.test(prefix)
  ) {
    fail('AUTH_POLICY_INVALID', 'outbound auth prefix is invalid');
  }
  return prefix;
}

async function resolveSecretValue(
  resolver: OutboundSecretResolver,
  secretRef: string,
): Promise<string> {
  let value: unknown;
  try {
    value = await resolver(secretRef);
  } catch {
    // Never surface the resolver's message: it may embed the value or path.
    fail('SECRET_RESOLVE_FAILED', 'outbound secret reference could not be resolved');
  }
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_SECRET_LENGTH
    || !PRINTABLE.test(value)
    || CONTROL.test(value)
  ) {
    fail('SECRET_VALUE_INVALID', 'resolved outbound secret value is invalid');
  }
  return value;
}

function assertUniqueHeaderNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) fail('HEADER_CONFLICT', 'outbound auth header names must be unique');
    seen.add(name);
  }
}

/**
 * Build the session for one delivery attempt. Policy shape and all header
 * metadata are validated eagerly; secret VALUES and tokens stay lazy so a
 * revoked reference fails at dispatch time (after egress adjudication), not at
 * admission.
 */
export function createOutboundAuthSession(
  policy: OutboundAuthPolicy,
  dependencies: OutboundAuthDependencies,
): OutboundAuthSession {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('AUTH_POLICY_INVALID', 'outbound auth policy is missing');
  }
  if (typeof dependencies?.resolveSecret !== 'function') {
    fail('AUTH_POLICY_INVALID', 'an outbound secret resolver is required');
  }

  if (policy.mode === 'none') {
    return {
      mode: 'none',
      canReacquireOn401: false,
      async headersForAttempt() {
        return {};
      },
      invalidate() {
        /* nothing cached */
      },
    };
  }

  if (policy.mode === 'configured_headers') {
    if (!Array.isArray(policy.headers) || policy.headers.length < 1 || policy.headers.length > 4) {
      fail('AUTH_POLICY_INVALID', 'configured_headers requires between one and four headers');
    }
    const validated = policy.headers.map((header) => {
      if (!header || typeof header !== 'object') fail('AUTH_POLICY_INVALID', 'configured header entry is invalid');
      const name = validateHeaderName(header.name, OUTBOUND_SECRET_HEADER_ALLOWLIST);
      const secretRef = validateSecretRef(header.secretRef);
      const prefix = validatePrefix(header.prefix);
      return { name, secretRef, ...(prefix === undefined ? {} : { prefix }) };
    });
    assertUniqueHeaderNames(validated.map((header) => header.name));
    return {
      mode: 'configured_headers',
      canReacquireOn401: false,
      async headersForAttempt() {
        const headers: Record<string, string> = {};
        for (const header of validated) {
          const value = await resolveSecretValue(dependencies.resolveSecret, header.secretRef);
          headers[header.name] = header.prefix ? header.prefix + value : value;
        }
        return headers;
      },
      invalidate() {
        /* secret headers hold no cache */
      },
    };
  }

  if (policy.mode === 'oauth2_client_credentials') {
    if (!policy.config || typeof policy.config !== 'object') {
      fail('AUTH_POLICY_INVALID', 'oauth2_client_credentials requires a token config');
    }
    const extraHeaders = (policy.extraHeaders ?? []).map((header) => {
      if (!header || typeof header !== 'object') fail('AUTH_POLICY_INVALID', 'oauth2 extra header entry is invalid');
      const name = validateHeaderName(header.name);
      const value = validateHeaderValue(header.value, 'oauth2 extra header value');
      return { name, value };
    });
    // Authorization is minted from the access token; a policy that also sets
    // it (or a duplicate of any extra header) is a conflict, not a merge.
    assertUniqueHeaderNames(['authorization', ...extraHeaders.map((header) => header.name)]);

    const client = new OAuth2TokenClient(policy.config, dependencies.cacheScope ?? { tenantId: 'unknown' }, dependencies.oauth2Options);
    return {
      mode: 'oauth2_client_credentials',
      canReacquireOn401: true,
      async headersForAttempt() {
        let token: string;
        try {
          token = await client.getToken();
        } catch (error) {
          const code = error instanceof OAuth2Error ? error.code : 'TOKEN_ACQUISITION_FAILED';
          // Fixed text + code only: never the token endpoint body, URL query
          // or credential material.
          fail('TOKEN_ACQUISITION_FAILED', 'oauth2 token acquisition failed (' + code + ')');
        }
        const headers: Record<string, string> = {};
        for (const header of extraHeaders) headers[header.name] = header.value;
        headers.authorization = 'Bearer ' + token;
        return headers;
      },
      invalidate() {
        client.invalidate();
      },
    };
  }

  return fail('AUTH_POLICY_INVALID', 'outbound auth mode is not supported');
}

/**
 * Run one authenticated delivery, retrying AT MOST ONCE on an invalid-token
 * 401 (OAuth2 only): invalidate the exact cache entry, reacquire, resend with
 * the same caller closure (deliveryId, body and signature stay unchanged).
 * Any other status — including a second 401 or a 403 — is returned as-is.
 */
export interface OutboundDispatchResult {
  status: number;
  attempts: 1 | 2;
}

export async function dispatchWithAuth(
  session: OutboundAuthSession,
  send: (headers: Record<string, string>) => Promise<{ status: number }>,
): Promise<OutboundDispatchResult> {
  const firstHeaders = await session.headersForAttempt();
  const first = await send(firstHeaders);
  if (first.status === 401 && session.canReacquireOn401) {
    session.invalidate();
    const secondHeaders = await session.headersForAttempt();
    const second = await send(secondHeaders);
    return { status: second.status, attempts: 2 };
  }
  return { status: first.status, attempts: 1 };
}
