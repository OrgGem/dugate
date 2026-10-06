/**
 * COMP-01: legacy header / query canonicalization for the compatibility layer.
 *
 * This module is deliberately ISOLATED. It imports nothing from `server.ts` and
 * nothing from `packages/contracts/public-api.ts`, so it can be adopted later
 * without either file having to change first. It only depends on `node:crypto`
 * (already used across the orchestrator) for nothing beyond a stable id, and
 * the header bag is a plain record so it can be handed in from any caller.
 *
 * Canonical forms (what a caller should SEND):
 *   - credential:   `Authorization: Bearer <token>`  OR  `x-api-key: <key>`
 *   - content type: `application/json`, `application/problem+json`,
 *                  `application/octet-stream`, `text/html; charset=utf-8`
 *   - pagination:   `?limit=N&cursor=<token>&sort=<field>` (keyset, NOT offset)
 *
 * Legacy forms this normalizes:
 *   - credential headers: `X-API-Key` case variants, `api-key`, `token`,
 *     `x-auth-token`, `Authorization` with a lowercase `bearer` scheme or
 *     extra whitespace.
 *   - content types: `text/json`, `application/x-json`, `application/json;
 *     charset=utf-8` with odd casing, missing charset on a JSON type.
 *   - pagination: `page`/`pageSize`/`per_page`/`offset`/`from`/`to` mapped onto
 *     the canonical `limit` + a sentinel cursor where an offset was used.
 *
 * Every function here is PURE: same input, same output, no clock, no network.
 */

/** A raw header bag: lowercase keys, string | string[] values, as Node gives. */
export type RawHeaderBag = Record<string, string | string[] | undefined>;

/** The canonical content types this layer understands. */
export const CANONICAL_CONTENT_TYPES = {
  json: 'application/json',
  problem: 'application/problem+json',
  octetStream: 'application/octet-stream',
  html: 'text/html; charset=utf-8',
} as const;

export type CanonicalContentType = (typeof CANONICAL_CONTENT_TYPES)[keyof typeof CANONICAL_CONTENT_TYPES];

/** Canonical query names. Anything else is legacy or ignored. */
export const CANONICAL_QUERY_KEYS = ['limit', 'cursor', 'sort'] as const;

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface CanonicalCredential {
  /** Which canonical mechanism carried the credential. */
  readonly scheme: 'bearer' | 'api-key';
  /** The extracted secret. Empty string when none was present. */
  readonly token: string;
  /** Header key we will instruct the caller to use going forward. */
  readonly canonicalHeader: 'authorization' | 'x-api-key';
}

export interface CanonicalContentTypeResult {
  /** The normalized value, or null when the input could not be recognized. */
  readonly contentType: CanonicalContentType | null;
  /** True when the input differed from the canonical spelling. */
  readonly wasLegacy: boolean;
}

export interface CanonicalPagination {
  readonly limit: number;
  /** Canonical keyset cursor; null when the caller used no legacy offset. */
  readonly cursor: string | null;
  readonly sort: string | null;
  /** True when any legacy query key (page/pageSize/offset/per_page) was folded in. */
  readonly wasLegacy: boolean;
}

const LEGACY_API_KEY_HEADERS = ['x-api-key', 'api-key', 'apikey', 'x-apikey'] as const;
const LEGACY_TOKEN_HEADERS = ['x-auth-token', 'x-token', 'token', 'auth-token'] as const;

function firstValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Header keys are case-insensitive; this finds the first matching key. */
function findHeader(headers: RawHeaderBag, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return firstValue(headers[key]);
  }
  return undefined;
}

function firstPresent(headers: RawHeaderBag, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = findHeader(headers, name);
    if (value !== undefined && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * Extract a credential from legacy or canonical header spellings.
 *
 * Precedence is deliberate: an explicit `Authorization: Bearer` wins over any
 * `X-API-Key`-style header, because a caller that set both meant the bearer to
 * win. A token is never logged or echoed here - only returned to the caller
 * that will hash it itself.
 */
export function canonicalizeCredential(headers: RawHeaderBag): CanonicalCredential {
  const authorization = findHeader(headers, 'authorization');
  if (authorization !== undefined) {
    const trimmed = authorization.trim();
    // `Bearer ` is matched case-insensitively: HTTP auth schemes are
    // case-insensitive per RFC 7235, and a lowercase `bearer` is a real
    // legacy client behaviour rather than an attack.
    const match = /^bearer\s+(.+)$/i.exec(trimmed);
    if (match) {
      const token = match[1]!.trim();
      return {
        scheme: 'bearer',
        token,
        canonicalHeader: 'authorization',
      };
    }
  }
  const apiKey = firstPresent(headers, LEGACY_API_KEY_HEADERS);
  if (apiKey !== undefined) {
    return { scheme: 'api-key', token: apiKey.trim(), canonicalHeader: 'x-api-key' };
  }
  const token = firstPresent(headers, LEGACY_TOKEN_HEADERS);
  if (token !== undefined) {
    return { scheme: 'api-key', token, canonicalHeader: 'x-api-key' };
  }
  return { scheme: 'bearer', token: '', canonicalHeader: 'authorization' };
}

/**
 * Normalize a `content-type` header, including its parameters.
 *
 * A JSON type with a charset is a legacy spelling here: the canonical JSON
 * types carry no charset, because the body is always UTF-8. An unrecognized
 * type returns null rather than a guess - the caller must fail closed rather
 * than coerce an arbitrary `application/octet-stream; x=1` into something it
 * did not send.
 */
export function canonicalizeContentType(raw: string | string[] | undefined): CanonicalContentTypeResult {
  const value = firstValue(raw);
  if (value === undefined || value.trim() === '') return { contentType: null, wasLegacy: false };

  // Split off parameters, lowercase, and trim whitespace around the media type.
  const [mediaRaw = '', ...params] = value.split(';');
  const media = mediaRaw.trim().toLowerCase();
  const hadCharset = params.some((p) => p.trim().toLowerCase().startsWith('charset='));

  const jsonLike = media === 'application/json' || media === 'text/json' || media === 'application/x-json';
  const problemLike = media === 'application/problem+json';
  const octet = media === 'application/octet-stream';
  const html = media === 'text/html';

  let contentType: CanonicalContentType | null = null;
  if (jsonLike) contentType = CANONICAL_CONTENT_TYPES.json;
  else if (problemLike) contentType = CANONICAL_CONTENT_TYPES.problem;
  else if (octet) contentType = CANONICAL_CONTENT_TYPES.octetStream;
  else if (html) contentType = CANONICAL_CONTENT_TYPES.html;

  if (contentType === null) return { contentType: null, wasLegacy: false };
  // Legacy if the caller spelled it differently OR attached a charset that the
  // canonical form does not carry.
  const wasLegacy = media !== contentType.split(';')[0]!.trim().toLowerCase() || hadCharset;
  return { contentType, wasLegacy };
}

/**
 * A legacy offset page cannot be expressed as a canonical keyset cursor.
 *
 * This is the one mapping in the whole module that CANNOT be done honestly:
 * `?page=2` means "skip 20 rows", while `?cursor=X` means "start at the row
 * after the one X names". Those agree only when the underlying ordering is
 * stable, which is exactly the assumption a legacy offset page does not make.
 * So the module reports the incompatibility instead of fabricating a cursor.
 */
export interface CanonicalPaginationResult extends CanonicalPagination {
  /**
   * Set when a legacy `page`/`offset`/`per_page` was present: the caller must
   * either drop the parameter or migrate, because no cursor can stand in for it.
   */
  readonly offsetNotExpressible: string | null;
}

function readParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value === null || value === '' ? null : value;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
  const whole = Math.floor(value);
  if (whole < 1) return DEFAULT_PAGE_LIMIT;
  return whole > MAX_PAGE_LIMIT ? MAX_PAGE_LIMIT : whole;
}

/**
 * Map legacy pagination query params onto the canonical keyset form.
 *
 * `limit`/`cursor`/`sort` pass through. `per_page` and `pageSize` are a limit
 * under another name and fold cleanly. `page` and `offset` are reported as not
 * expressible rather than converted.
 */
export function canonicalizePagination(
  search: string | URLSearchParams,
): CanonicalPaginationResult {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;

  let limit = DEFAULT_PAGE_LIMIT;
  let wasLegacy = false;
  let offsetNotExpressible: string | null = null;

  const rawLimit = readParam(params, 'limit');
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (Number.isFinite(parsed)) limit = clampLimit(parsed);
  } else {
    const perPage = readParam(params, 'per_page') ?? readParam(params, 'pageSize');
    if (perPage !== null) {
      const parsed = Number(perPage);
      if (Number.isFinite(parsed)) {
        limit = clampLimit(parsed);
        wasLegacy = true;
      }
    }
  }

  const page = readParam(params, 'page');
  if (page !== null) {
    wasLegacy = true;
    offsetNotExpressible = `page=${page} is an offset page, not a keyset position`;
  }
  const offset = readParam(params, 'offset');
  if (offset !== null) {
    wasLegacy = true;
    offsetNotExpressible = `offset=${offset} is an offset page, not a keyset position`;
  }

  return {
    limit,
    cursor: readParam(params, 'cursor'),
    sort: readParam(params, 'sort'),
    wasLegacy,
    offsetNotExpressible,
  };
}

/** One pass over a raw request: canonical credential, content type and page. */
export interface CanonicalRequest {
  readonly credential: CanonicalCredential;
  readonly contentType: CanonicalContentType | null;
  readonly pagination: CanonicalPaginationResult;
  /** Any legacy spelling was seen anywhere in the request. */
  readonly wasLegacy: boolean;
}

/**
 * Canonicalize a whole request in one call.
 *
 * Note the signature takes the header bag and the query string SEPARATELY rather
 * than a parsed `RouteContext`: this module is not allowed to depend on the
 * server's context type, and taking the two raw pieces keeps that isolation
 * structural instead of merely conventional.
 */
export function canonicalizeRequest(
  headers: RawHeaderBag,
  search: string | URLSearchParams,
): CanonicalRequest {
  const credential = canonicalizeCredential(headers);
  const contentType = canonicalizeContentType(findHeader(headers, 'content-type'));
  const pagination = canonicalizePagination(search);
  return {
    credential,
    contentType: contentType.contentType,
    pagination,
    wasLegacy:
      contentType.wasLegacy
      || pagination.wasLegacy
      || (credential.scheme === 'api-key' && credential.token !== ''),
  };
}
