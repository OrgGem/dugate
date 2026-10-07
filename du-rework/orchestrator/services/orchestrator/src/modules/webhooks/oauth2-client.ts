import { createHash } from 'node:crypto';

/**
 * CB-03 (PROFILE-CALLBACK-20261006) — OAuth2 `client_credentials` token client
 * for authenticated outbound callbacks.
 *
 * Scope of this module is deliberately narrow: fetch, validate and cache an
 * access token; hand it to the caller. It knows nothing about webhook rows,
 * delivery retries or profiles — the outbound-auth session composes it.
 *
 * Invariants (RFC 6749 §2.3/§4.4, RFC 6750 §2.1):
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

export type OAuth2ClientSecretProvider = () => string | Promise<string>;

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
  /** Injectable fetch (tests); production uses global fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
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
  /** Whole-request timeout. Default 10 s. */
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
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
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
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.requestToken();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt >= this.maxAttempts) break;
        if (this.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
    }
    throw lastError instanceof OAuth2Error
      ? lastError
      : new OAuth2Error('TOKEN_REQUEST_FAILED', 'token acquisition failed');
  }

  private async requestToken(): Promise<{ token: string; expiresInSeconds: number | null }> {
    const secret = typeof this.config.clientSecret === 'function'
      ? await this.resolveSecret(this.config.clientSecret)
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.tokenUrl, {
        method: 'POST',
        headers,
        body: form.toString(),
        // Redirects are forbidden for credential-bearing requests: a 30x
        // could forward Basic/body credentials to another origin.
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new OAuth2Error('TOKEN_REQUEST_FAILED', 'token endpoint is unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 200) {
      throw new OAuth2Error('TOKEN_HTTP_ERROR', 'token endpoint answered a non-success status', response.status);
    }
    const contentType = response.headers?.get('content-type') ?? null;
    if (contentType !== null && !/application\/(?:[a-z0-9.+-]*\+)?json/i.test(contentType)) {
      throw new OAuth2Error('TOKEN_RESPONSE_INVALID', 'token response is not JSON');
    }
    const declaredLength = Number(response.headers?.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new OAuth2Error('TOKEN_RESPONSE_TOO_LARGE', 'token response exceeds the configured bound');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new OAuth2Error('TOKEN_REQUEST_FAILED', 'token response could not be read');
    }
    if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
      throw new OAuth2Error('TOKEN_RESPONSE_TOO_LARGE', 'token response exceeds the configured bound');
    }
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

  private async resolveSecret(provider: OAuth2ClientSecretProvider): Promise<string> {
    let secret: unknown;
    try {
      secret = await provider();
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
