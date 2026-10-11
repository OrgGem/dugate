import { createHash } from 'node:crypto';
import { createPinnedFetch, DestinationDeniedError } from '@du/egress';

/**
 * CB-03 (PROFILE-CALLBACK-20261006) — OAuth2 `client_credentials` token client
 * for authenticated outbound callbacks.
 *
 * Scope of this module is deliberately narrow: fetch, validate and cache an
 * access token; hand it to the caller. It knows nothing about webhook rows,
 * delivery retries or profiles — the outbound-auth session composes it.
 *
 * Invariants (RFC 6749 §2.3/§4.4, RFC 6750 §2.1):
 * - The token request rides the shared pinned egress transport (@du/egress): every
 *   DNS answer is adjudicated before any connect, ONE resolution feeds both policy and
 *   connect (no rebinding window), private/loopback/link-local/metadata destinations
 *   are refused unless the deployment opts in explicitly, and a 30x is never followed
 *   (RFC 6749 §10.6 — credentials must not cross an origin).
 * - The response body is bounded while it is READ: the deadline and the byte cap stay
 *   armed to the last byte, and a breach cancels the stream instead of buffering to EOF.
 * - HTTPS token URL required (the internal DU HTTP transport exception is
 *   opt-in via `allowInsecureHttp`, never a default); no userinfo, query or
 *   fragment in the configured URL.
 * - POST `application/x-www-form-urlencoded`; `client_secret_basic` (HTTP
 *   Basic, RFC 6749 form-urlencoded encoding) or `client_secret_post`; never
 *   both.
 * - Validates status 200, bounded JSON body, non-empty `access_token`,
 *   `token_type` Bearer (case-insensitive) and `expires_in`. A missing
 *   lifetime is NEVER cached indefinitely: default is "no cache" (fetch per
 *   delivery) unless an explicit provider lifetime policy is configured.
 * - Process-memory cache only, scoped by the caller-supplied
 *   (tenant/profile/revision/endpoint/credential generation) plus token
 *   endpoint/client/scope/audience/resource. Renews before expiry with a
 *   bounded clock skew; single-flight so concurrent callers share one fetch.
 * - `invalidate()` drops the exact entry (401/rotation); the next call
 *   reacquires. No refresh_token, no redirect following, no plaintext
 *   fallback.
 * - Tokens/secrets never enter URLs, error strings or logs: errors carry a
 *   fixed code and the HTTP status only.
 */

export type OAuth2ClientAuthMethod = 'client_secret_basic' | 'client_secret_post';

export type OAuth2ClientSecretProvider = (signal?: AbortSignal) => string | Promise<string>;

export interface OAuth2ClientCredentialsConfig {
  /** Token endpoint. https required unless `allowInsecureHttp` (internal exception). */
  tokenUrl: string;
  clientId: string;
  /**
   * Client secret value or a provider resolved at TOKEN-FETCH time (rotation
   * applies without reconstructing the client). Never logged or echoed.
   */
  clientSecret: string | OAuth2ClientSecretProvider;
  authMethod: OAuth2ClientAuthMethod;
  scope?: string;
  /** Optional provider extensions, explicitly supported by the deployment. */
  audience?: string;
  resource?: string;
  /**
   * Bounded allowlisted extension form parameters. Reserved OAuth fields
   * (grant_type/client_id/client_secret/scope/audience/resource) are rejected.
   */
  extensionParams?: Readonly<Record<string, string>>;
}

/**
 * Cache scope. Every field participates in the cache key; changing any of
 * them (new revision, rotated credential generation, different endpoint)
 * means a different token entry by construction.
 */
export interface OAuth2CacheScope {
  tenantId: string;
  profileId?: string;
  profileRevision?: number | string;
  /** Endpoint identity (endpointSlug or canonical action name). */
  endpointKey?: string;
  /** Rotation/revocation fence: a new generation never reuses the old token. */
  credentialGeneration?: number | string;
}

export type OAuth2MissingLifetimePolicy =
  | { mode: 'no-cache' }
  | { mode: 'assume-seconds'; seconds: number };

export interface OAuth2TokenClientOptions {
  /**
   * Transport seam for tests/instrumentation. When injected it REPLACES the egress
   * transport outright, so that caller owns destination policy for the run; the
   * production default is the shared pinned egress fetch (see the options below).
   */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Exact IP-literal opt-ins (narrow local-mesh convention, as in the webhook dispatcher). */
  allowHosts?: ReadonlySet<string>;
  /** Explicit RFC1918/loopback/ULA opt-in. Never metadata, link-local or CGNAT. Default false. */
  allowPrivateNetworks?: boolean;
  /** Resolver seam for the egress transport: returns EVERY answer, and all of them are adjudicated. */
  resolveDns?: (host: string) => Promise<string[]>;
  /** Clock override for tests / deterministic renewal. */
  now?: () => number;
  /** Renew this many seconds before expiry. Default 30; clamped to half the lifetime. */
  renewSkewSeconds?: number;
  /** Lifetime policy when the provider omits `expires_in`. Default no-cache. */
  missingExpiresIn?: OAuth2MissingLifetimePolicy;
  /** Bounded acquisition attempts for retryable transport/5xx failures. Default 2. */
  maxAttempts?: number;
  /** Delay between retryable attempts. Default 250 ms (tests inject 0). */
  retryDelayMs?: number;
  /** Whole token acquisition deadline, including secret resolution, retries, DNS, and body. Default 10 s. */
  timeoutMs?: number;
  /** Maximum accepted token response body. Default 64 KiB. */
  maxResponseBytes?: number;
  /** Upper bound on a cached lifetime. Default 24 h. */
  maxLifetimeSeconds?: number;
  /** Opt-in for the internal DU plaintext-HTTP exception. Default false. */
  allowInsecureHttp?: boolean;
}

export type OAuth2ErrorCode =
  | 'TOKEN_URL_INVALID'
  | 'TOKEN_ENDPOINT_DENIED'
  | 'TOKEN_REQUEST_FAILED'
  | 'TOKEN_HTTP_ERROR'
  | 'TOKEN_RESPONSE_INVALID'
  | 'TOKEN_RESPONSE_TOO_LARGE'
  | 'TOKEN_TYPE_INVALID'
  | 'TOKEN_CONFIG_INVALID';

/** Secret-free typed failure. Message text never carries tokens/credentials. */
export class OAuth2Error extends Error {
  public constructor(
    public readonly code: OAuth2ErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuth2Error';
  }
}

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRINTABLE = /^[\x20-\x7e]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const DEFAULT_RENEW_SKEW_SECONDS = 30;
const MAX_ACCESS_TOKEN_LENGTH = 4096;
const MAX_PARAM_VALUE_LENGTH = 2048;
const RESERVED_FORM_FIELDS = new Set(['grant_type', 'client_id', 'client_secret', 'scope', 'audience', 'resource']);

function invalid(code: OAuth2ErrorCode, message: string, status?: number): never {
  throw new OAuth2Error(code, message, status);
}

/** Normalize exact IP-literal opt-ins: lowercase, strip IPv6 brackets, reject junk. */
function normalizeAllowHosts(raw: ReadonlySet<string> | undefined): Set<string> | undefined {
  if (raw === undefined) return undefined;
  const out = new Set<string>();
  for (const host of raw) {
    if (typeof host !== 'string' || host.length < 1 || host.length > 253 || CONTROL.test(host)) {
      invalid('TOKEN_CONFIG_INVALID', 'allowHosts entry is invalid');
    }
    out.add(host.toLowerCase().replace(/^\[|\]$/g, ''));
  }
  return out.size > 0 ? out : undefined;
}

async function cancelQuietly(reader: { cancel: () => Promise<void> }): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    /* stream already closed or errored */
  }
}

interface AcquisitionDeadline {
  controller: AbortController;
  gate: Promise<never>;
  timedOut: boolean;
  dispose: () => void;
}

function createAcquisitionDeadline(timeoutMs: number): AcquisitionDeadline {
  const controller = new AbortController();
  let rejectOnDeadline: ((reason: OAuth2Error) => void) | null = null;
  let timedOut = false;
  const gate = new Promise<never>((_resolve, reject) => {
    rejectOnDeadline = reject;
  });
  // A deadline can fire while no operation is currently racing the gate.
  gate.catch(() => undefined);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectOnDeadline?.(new OAuth2Error('TOKEN_REQUEST_FAILED', 'token acquisition exceeded its deadline'));
  }, timeoutMs);

  return {
    controller,
    gate,
    get timedOut(): boolean { return timedOut; },
    dispose: () => {
      clearTimeout(timer);
      rejectOnDeadline = null;
    },
  };
}

function raceWithDeadline<T>(operation: Promise<T>, deadline: AcquisitionDeadline): Promise<T> {
  return Promise.race([operation, deadline.gate]);
}

async function delayWithinDeadline(milliseconds: number, deadline: AcquisitionDeadline): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  try {
    await raceWithDeadline(delay, deadline);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function cancelResponse(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    /* response is already consumed, locked, or closed */
  }
}

function assertPrintable(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || !PRINTABLE.test(value)) {
    invalid('TOKEN_CONFIG_INVALID', label + ' is invalid');
  }
  return value;
}

function validateTokenUrl(raw: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid('TOKEN_URL_INVALID', 'token URL is not a valid URL');
  }
  if (url.username || url.password) invalid('TOKEN_URL_INVALID', 'token URL must not carry userinfo');
  if (url.hash) invalid('TOKEN_URL_INVALID', 'token URL must not carry a fragment');
  if (url.search) invalid('TOKEN_URL_INVALID', 'token URL must not carry a query string');
  if (url.protocol === 'https:') return url.href;
  if (allowInsecureHttp && url.protocol === 'http:') return url.href;
  invalid('TOKEN_URL_INVALID', 'token URL must use https (internal DU http is opt-in)');
}

/** Cache key material — contains no secret. Exported for tests/diagnostics. */
export function oauth2CacheKey(config: OAuth2ClientCredentialsConfig, scope: OAuth2CacheScope): string {
  const material = JSON.stringify({
    v: 1,
    cacheScope: {
      tenantId: scope.tenantId ?? '',
      profileId: scope.profileId ?? '',
      profileRevision: scope.profileRevision ?? '',
      endpointKey: scope.endpointKey ?? '',
      credentialGeneration: scope.credentialGeneration ?? '',
    },
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    authMethod: config.authMethod,
    scope: config.scope ?? '',
    audience: config.audience ?? '',
    resource: config.resource ?? '',
  });
  return createHash('sha256').update(material).digest('hex');
}

interface ValidatedConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string | OAuth2ClientSecretProvider;
  authMethod: OAuth2ClientAuthMethod;
  scope?: string;
  audience?: string;
  resource?: string;
  extensionParams: Array<[string, string]>;
}

interface CachedToken {
  token: string;
  renewAt: number;
}

export class OAuth2TokenClient {
  private readonly config: ValidatedConfig;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly renewSkewMs: number;
  private readonly missingExpiresIn: OAuth2MissingLifetimePolicy;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxLifetimeSeconds: number;

  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;
  /** Guards against a slow fetch writing a token invalidated meanwhile. */
  private epoch = 0;

  public readonly cacheKey: string;

  public constructor(
    config: OAuth2ClientCredentialsConfig,
    scope: OAuth2CacheScope,
    options: OAuth2TokenClientOptions = {},
  ) {
    if (config.authMethod !== 'client_secret_basic' && config.authMethod !== 'client_secret_post') {
      invalid('TOKEN_CONFIG_INVALID', 'authMethod must be client_secret_basic or client_secret_post');
    }
    assertPrintable(scope?.tenantId, 'cache scope tenantId', 256);
    const allowInsecureHttp = options.allowInsecureHttp === true;
    const extensionParams: Array<[string, string]> = [];
    for (const [name, value] of Object.entries(config.extensionParams ?? {})) {
      if (!HEADER_NAME_RE.test(name) || name.length > 64) {
        invalid('TOKEN_CONFIG_INVALID', 'extension parameter name is invalid');
      }
      if (RESERVED_FORM_FIELDS.has(name.toLowerCase())) {
        invalid('TOKEN_CONFIG_INVALID', 'extension parameter overrides a reserved OAuth field');
      }
      if (typeof value !== 'string' || value.length > MAX_PARAM_VALUE_LENGTH || CONTROL.test(value)) {
        invalid('TOKEN_CONFIG_INVALID', 'extension parameter value is invalid');
      }
      extensionParams.push([name, value]);
    }
    if (extensionParams.length > 16) {
      invalid('TOKEN_CONFIG_INVALID', 'too many extension parameters');
    }
    this.config = {
      tokenUrl: validateTokenUrl(String(config.tokenUrl ?? ''), allowInsecureHttp),
      clientId: assertPrintable(config.clientId, 'client_id', 256),
      clientSecret: config.clientSecret,
      authMethod: config.authMethod,
      ...(config.scope === undefined ? {} : { scope: assertPrintable(config.scope, 'scope', 1024) }),
      ...(config.audience === undefined ? {} : { audience: assertPrintable(config.audience, 'audience', 1024) }),
      ...(config.resource === undefined ? {} : { resource: assertPrintable(config.resource, 'resource', 1024) }),
      extensionParams,
    };
    if (typeof config.clientSecret === 'string') {
      assertPrintable(config.clientSecret, 'client_secret', MAX_ACCESS_TOKEN_LENGTH);
    } else if (typeof config.clientSecret !== 'function') {
      invalid('TOKEN_CONFIG_INVALID', 'clientSecret must be a string or a provider');
    }
    const renewSkewSeconds = options.renewSkewSeconds ?? DEFAULT_RENEW_SKEW_SECONDS;
    if (!Number.isFinite(renewSkewSeconds) || renewSkewSeconds < 0 || renewSkewSeconds > 3600) {
      invalid('TOKEN_CONFIG_INVALID', 'renewSkewSeconds must be between 0 and 3600');
    }
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      invalid('TOKEN_CONFIG_INVALID', 'maxAttempts must be between 1 and 5');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      invalid('TOKEN_CONFIG_INVALID', 'timeoutMs must be a positive integer');
    }
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      invalid('TOKEN_CONFIG_INVALID', 'maxResponseBytes must be a positive integer');
    }
    const maxLifetimeSeconds = options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
    if (!Number.isSafeInteger(maxLifetimeSeconds) || maxLifetimeSeconds < 1) {
      invalid('TOKEN_CONFIG_INVALID', 'maxLifetimeSeconds must be a positive integer');
    }
    const missingExpiresIn = options.missingExpiresIn ?? { mode: 'no-cache' };
    if (missingExpiresIn.mode === 'assume-seconds') {
      if (!Number.isSafeInteger(missingExpiresIn.seconds) || missingExpiresIn.seconds < 1) {
        invalid('TOKEN_CONFIG_INVALID', 'assumed token lifetime must be a positive integer');
      }
    } else if (missingExpiresIn.mode !== 'no-cache') {
      invalid('TOKEN_CONFIG_INVALID', 'missingExpiresIn policy is invalid');
    }
    const allowHosts = normalizeAllowHosts(options.allowHosts);
    if (options.allowPrivateNetworks !== undefined && typeof options.allowPrivateNetworks !== 'boolean') {
      invalid('TOKEN_CONFIG_INVALID', 'allowPrivateNetworks must be a boolean');
    }
    if (options.resolveDns !== undefined && typeof options.resolveDns !== 'function') {
      invalid('TOKEN_CONFIG_INVALID', 'resolveDns must be a function');
    }
    // No injected transport => the shared pinned egress fetch: adjudication and the
    // connect share ONE DNS resolution, so the answer that passed policy is the
    // address actually dialed (no rebinding window).
    this.fetchImpl = options.fetchImpl ?? createPinnedFetch({
      ...(allowHosts === undefined ? {} : { allowHosts }),
      ...(options.allowPrivateNetworks === true ? { allowPrivateNetworks: true } : {}),
      ...(options.resolveDns === undefined ? {} : { resolve: options.resolveDns }),
    });
    this.now = options.now ?? Date.now;
    this.renewSkewMs = renewSkewSeconds * 1000;
    this.missingExpiresIn = missingExpiresIn;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxLifetimeSeconds = maxLifetimeSeconds;
    this.cacheKey = oauth2CacheKey({ ...config, tokenUrl: this.config.tokenUrl }, scope);
  }

  /**
   * The cached token or a fresh acquisition. Concurrent callers share one
   * in-flight request. Renews `renewSkewSeconds` before expiry.
   */
  public async getToken(): Promise<string> {
    const current = this.now();
    if (this.cached && current < this.cached.renewAt) return this.cached.token;
    if (this.inflight) return this.inflight;
    const epochAtStart = this.epoch;
    const attempt: Promise<string> = this.acquire().then((acquired) => {
      if (acquired.expiresInSeconds === null) {
        // Provider omitted a lifetime and the policy is "no cache": hand the
        // token to THIS delivery only; the next delivery acquires again.
        return acquired.token;
      }
      const ttlMs = acquired.expiresInSeconds * 1000;
      const effectiveSkew = Math.min(this.renewSkewMs, Math.floor(ttlMs / 2));
      if (epochAtStart === this.epoch) {
        this.cached = { token: acquired.token, renewAt: this.now() + ttlMs - effectiveSkew };
      }
      return acquired.token;
    }).finally(() => {
      if (this.inflight === attempt) this.inflight = null;
    });
    this.inflight = attempt;
    return attempt;
  }

  /** Drop the exact cache entry; the next getToken reacquires (no refresh_token). */
  public invalidate(): void {
    this.cached = null;
    this.epoch += 1;
  }

  private async acquire(): Promise<{ token: string; expiresInSeconds: number | null }> {
    const deadline = createAcquisitionDeadline(this.timeoutMs);
    try {
      return await raceWithDeadline(this.acquireWithinDeadline(deadline), deadline);
    } finally {
      deadline.dispose();
    }
  }

  private async acquireWithinDeadline(
    deadline: AcquisitionDeadline,
  ): Promise<{ token: string; expiresInSeconds: number | null }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.requestToken(deadline);
      } catch (error) {
        lastError = error;
        if (deadline.timedOut || !isRetryable(error) || attempt >= this.maxAttempts) break;
        if (this.retryDelayMs > 0) {
          await delayWithinDeadline(this.retryDelayMs, deadline);
        }
      }
    }
    throw lastError instanceof OAuth2Error
      ? lastError
      : new OAuth2Error('TOKEN_REQUEST_FAILED', 'token acquisition failed');
  }

  private async requestToken(deadline: AcquisitionDeadline): Promise<{ token: string; expiresInSeconds: number | null }> {
    const secret = typeof this.config.clientSecret === 'function'
      ? await raceWithDeadline(this.resolveSecret(this.config.clientSecret, deadline.controller.signal), deadline)
      : this.config.clientSecret;
    const form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    if (this.config.scope !== undefined) form.set('scope', this.config.scope);
    if (this.config.audience !== undefined) form.set('audience', this.config.audience);
    if (this.config.resource !== undefined) form.set('resource', this.config.resource);
    for (const [name, value] of this.config.extensionParams) form.set(name, value);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (this.config.authMethod === 'client_secret_basic') {
      const encoded = Buffer.from(
        encodeURIComponent(this.config.clientId) + ':' + encodeURIComponent(secret),
        'utf8',
      ).toString('base64');
      headers.authorization = 'Basic ' + encoded;
    } else {
      form.set('client_id', this.config.clientId);
      form.set('client_secret', secret);
    }

    const response = await this.fetchTokenResponse(deadline, headers, form.toString());
    if (response.status !== 200) {
      cancelResponse(response);
      invalid('TOKEN_HTTP_ERROR', 'token endpoint answered a non-success status', response.status);
    }
    const contentType = response.headers?.get('content-type') ?? null;
    if (contentType !== null && !/application\/(?:[a-z0-9.+-]*\+)?json/i.test(contentType)) {
      cancelResponse(response);
      invalid('TOKEN_RESPONSE_INVALID', 'token response is not JSON');
    }
    const declaredLength = Number(response.headers?.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      cancelResponse(response);
      invalid('TOKEN_RESPONSE_TOO_LARGE', 'token response exceeds the configured bound');
    }
    const text = await this.readBoundedBody(response, deadline);
    return this.parseTokenResponse(text);
  }

  /**
   * Credential-bearing request on the pinned egress transport. Redirects are never
   * followed: a 30x could forward Basic/body credentials to another origin, which
   * RFC 6749 §10.6 forbids for token endpoints.
   */
  private async fetchTokenResponse(
    deadline: AcquisitionDeadline,
    headers: Record<string, string>,
    body: string,
  ): Promise<Response> {
    try {
      const pendingResponse = this.fetchImpl(this.config.tokenUrl, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: deadline.controller.signal,
      });
      const releaseLateResponse = pendingResponse.then((response) => {
        if (deadline.timedOut) cancelResponse(response);
        return response;
      });
      return await raceWithDeadline(releaseLateResponse, deadline);
    } catch (error) {
      if (deadline.timedOut) {
        invalid('TOKEN_REQUEST_FAILED', 'token request did not complete within its deadline');
      }
      if (error instanceof DestinationDeniedError) {
        invalid('TOKEN_ENDPOINT_DENIED', 'token endpoint destination is not permitted');
      }
      invalid('TOKEN_REQUEST_FAILED', 'token endpoint is unreachable');
    }
  }

  /**
   * Read the body under BOTH bounds. The cap is checked on every chunk - never after
   * a full buffer - and a breach or the deadline cancels the stream, so the socket is
   * released instead of being drained to EOF.
   */
  private async readBoundedBody(
    response: Response,
    deadline: AcquisitionDeadline,
  ): Promise<string> {
    const body = response.body;
    if (!body) return '';
    if (typeof body.getReader !== 'function') {
      cancelResponse(response);
      invalid('TOKEN_RESPONSE_INVALID', 'token response body cannot be read safely');
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const next = await raceWithDeadline(reader.read(), deadline);
        if (next.done) break;
        const chunk = next.value;
        if (chunk) {
          received += chunk.byteLength;
          if (received > this.maxResponseBytes) {
            invalid('TOKEN_RESPONSE_TOO_LARGE', 'token response exceeds the configured bound');
          }
          chunks.push(chunk);
        }
      }
    } catch (error) {
      if (error instanceof OAuth2Error) throw error;
      invalid('TOKEN_REQUEST_FAILED', deadline.timedOut
        ? 'token request did not complete within its deadline'
        : 'token response could not be read');
    } finally {
      void cancelQuietly(reader);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Token body shape plus the lifetime policy. Split out to keep ONE deadline. */
  private parseTokenResponse(text: string): { token: string; expiresInSeconds: number | null } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new OAuth2Error('TOKEN_RESPONSE_INVALID', 'token response is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new OAuth2Error('TOKEN_RESPONSE_INVALID', 'token response is not a JSON object');
    }
    const record = parsed as Record<string, unknown>;
    const accessToken = record['access_token'];
    if (
      typeof accessToken !== 'string'
      || accessToken.length < 1
      || accessToken.length > MAX_ACCESS_TOKEN_LENGTH
      || CONTROL.test(accessToken)
    ) {
      throw new OAuth2Error('TOKEN_RESPONSE_INVALID', 'token response has no usable access_token');
    }
    const tokenType = record['token_type'];
    if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
      // RFC 6749 §5.1: token_type is case-insensitive; this deployment only
      // accepts Bearer (RFC 6750 §2.1).
      throw new OAuth2Error('TOKEN_TYPE_INVALID', 'token response is not a Bearer token');
    }
    const rawExpiresIn = record['expires_in'];
    if (rawExpiresIn === undefined || rawExpiresIn === null) {
      if (this.missingExpiresIn.mode === 'assume-seconds') {
        return { token: accessToken, expiresInSeconds: this.missingExpiresIn.seconds };
      }
      return { token: accessToken, expiresInSeconds: null };
    }
    if (
      typeof rawExpiresIn !== 'number'
      || !Number.isFinite(rawExpiresIn)
      || rawExpiresIn <= 0
    ) {
      throw new OAuth2Error('TOKEN_RESPONSE_INVALID', 'token response expires_in is invalid');
    }
    return { token: accessToken, expiresInSeconds: Math.floor(rawExpiresIn) };
  }

  private async resolveSecret(provider: OAuth2ClientSecretProvider, signal: AbortSignal): Promise<string> {
    let secret: unknown;
    try {
      secret = await provider(signal);
    } catch {
      throw new OAuth2Error('TOKEN_REQUEST_FAILED', 'client secret reference could not be resolved');
    }
    if (
      typeof secret !== 'string'
      || secret.length < 1
      || secret.length > MAX_ACCESS_TOKEN_LENGTH
      || CONTROL.test(secret)
    ) {
      throw new OAuth2Error('TOKEN_REQUEST_FAILED', 'resolved client secret is invalid');
    }
    return secret;
  }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof OAuth2Error)) return false;
  if (error.code === 'TOKEN_REQUEST_FAILED') return true;
  if (error.code === 'TOKEN_HTTP_ERROR') {
    return typeof error.status === 'number' && error.status >= 500;
  }
  return false;
}
