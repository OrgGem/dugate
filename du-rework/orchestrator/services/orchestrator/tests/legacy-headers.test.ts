/**
 * COMP-01: legacy header / query canonicalization.
 *
 * The module under test is pure, so these are pure tests too - no server, no
 * DB, no clock. Pinned in the order the module claims to work: credential,
 * content type, then pagination.
 */
import {
  CANONICAL_CONTENT_TYPES,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  canonicalizeContentType,
  canonicalizeCredential,
  canonicalizePagination,
  canonicalizeRequest,
  type RawHeaderBag,
} from '../src/compat/legacy-headers';

describe('COMP-01 credential canonicalization', () => {
  it('reads a canonical Authorization bearer as-is', () => {
    const out = canonicalizeCredential({ authorization: 'Bearer abc123' });
    expect(out).toEqual({ scheme: 'bearer', token: 'abc123', canonicalHeader: 'authorization' });
  });

  it.each([
    ['a lowercase bearer scheme', 'bearer abc123'],
    ['an uppercase scheme', 'BEARER abc123'],
    ['mixed case', 'BeArEr abc123'],
    ['extra inner whitespace', 'Bearer    abc123'],
    ['surrounding whitespace', '  Bearer abc123  '],
  ])('accepts %s, because HTTP auth schemes are case-insensitive', (_label, raw) => {
    expect(canonicalizeCredential({ authorization: raw }).token).toBe('abc123');
  });

  it.each([
    ['X-API-Key', 'x-api-key'],
    ['X-Api-Key', 'X-Api-Key'],
    ['api-key', 'api-key'],
    ['apikey', 'apikey'],
    ['X-ApiKey', 'X-ApiKey'],
  ])('reads the legacy api-key header %s case-insensitively', (label, key) => {
    const out = canonicalizeCredential({ [key]: 'key-value' });
    expect(out).toEqual({ scheme: 'api-key', token: 'key-value', canonicalHeader: 'x-api-key' });
    expect(label.length).toBeGreaterThan(0);
  });

  it.each([['x-auth-token'], ['x-token'], ['token'], ['auth-token']])('reads the legacy token header %s', (key) => {
    expect(canonicalizeCredential({ [key]: 'tok' })).toEqual({
      scheme: 'api-key', token: 'tok', canonicalHeader: 'x-api-key',
    });
  });

  it('prefers Authorization when both an api key and a bearer are present', () => {
    const out = canonicalizeCredential({ 'x-api-key': 'key-value', authorization: 'Bearer bearer-value' });
    expect(out.scheme).toBe('bearer');
    expect(out.token).toBe('bearer-value');
  });

  it('falls through to the api key when Authorization is not a bearer', () => {
    const out = canonicalizeCredential({ 'x-api-key': 'key-value', authorization: 'Basic dXNlcjpwYXNz' });
    // A non-bearer Authorization must not swallow a usable api key.
    expect(out.scheme).toBe('api-key');
    expect(out.token).toBe('key-value');
  });

  it.each([
    ['an empty header bag', {}],
    ['an empty bearer value', { authorization: 'Bearer ' }],
    ['a bare scheme', { authorization: 'Bearer' }],
    ['an empty api key', { 'x-api-key': '' }],
    ['a whitespace-only api key', { 'x-api-key': '   ' }],
  ])('yields an EMPTY token for %s, never a fabricated one', (_label, headers) => {
    const out = canonicalizeCredential(headers as RawHeaderBag);
    expect(out.token).toBe('');
  });

  it('takes the first value when a header is repeated', () => {
    expect(canonicalizeCredential({ authorization: ['Bearer first', 'Bearer second'] }).token).toBe('first');
  });

  it('survives a header bag holding undefined and array values', () => {
    const headers: RawHeaderBag = { 'x-api-key': undefined, 'x-token': ['a', 'b'], authorization: undefined };
    expect(canonicalizeCredential(headers).token).toBe('a');
  });
});

describe('COMP-01 content-type canonicalization', () => {
  it.each([
    ['text/json', CANONICAL_CONTENT_TYPES.json],
    ['application/x-json', CANONICAL_CONTENT_TYPES.json],
    ['application/json', CANONICAL_CONTENT_TYPES.json],
    ['APPLICATION/JSON', CANONICAL_CONTENT_TYPES.json],
    ['  application/json  ', CANONICAL_CONTENT_TYPES.json],
    ['application/problem+json', CANONICAL_CONTENT_TYPES.problem],
    ['application/octet-stream', CANONICAL_CONTENT_TYPES.octetStream],
    ['text/html', CANONICAL_CONTENT_TYPES.html],
  ])('maps %s to its canonical form', (raw, expected) => {
    expect(canonicalizeContentType(raw).contentType).toBe(expected);
  });

  it.each([
    ['application/json; charset=utf-8'],
    ['text/json; charset=UTF-8'],
    ['application/x-json; charset=us-ascii'],
    ['application/problem+json; charset=utf-8'],
  ])('strips the charset from %s, which those canonical types never carry', (raw) => {
    const out = canonicalizeContentType(raw);
    expect(out.wasLegacy).toBe(true);
    expect(out.contentType).not.toContain('charset');
  });

  it('NORMALIZES a legacy charset on text/html rather than dropping it', () => {
    // text/html is the one canonical type that DOES carry a charset, so a
    // legacy iso-8859-1 is rewritten to utf-8 instead of being stripped. I
    // first asserted every canonical type was charset-free, which is wrong.
    const out = canonicalizeContentType('text/html; charset=iso-8859-1');
    expect(out.contentType).toBe(CANONICAL_CONTENT_TYPES.html);
    expect(out.contentType).toContain('charset=utf-8');
    expect(out.wasLegacy).toBe(true);
  });

  it('drops an unknown PARAMETER while keeping a recognized media type', () => {
    // The media type is what is recognized; x=1 is an unknown parameter and is
    // dropped. I first filed this under unrecognized type, which was wrong.
    const out = canonicalizeContentType('application/octet-stream; x=1');
    expect(out.contentType).toBe(CANONICAL_CONTENT_TYPES.octetStream);
    expect(out.contentType).not.toContain('x=1');
  });

  it.each([
    ['application/xml'],
    ['text/plain'],
    ['not a media type at all'],
    ['multipart/form-data; boundary=abc'],
  ])('returns null for the UNRECOGNIZED type %s, never a guess', (raw) => {
    const out = canonicalizeContentType(raw);
    expect(out.contentType).toBeNull();
    expect(out.wasLegacy).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('returns null for %s', (_label, raw) => {
    expect(canonicalizeContentType(raw).contentType).toBeNull();
  });

  it('takes the first value when the header is repeated', () => {
    expect(canonicalizeContentType(['text/json', 'application/xml']).contentType)
      .toBe(CANONICAL_CONTENT_TYPES.json);
  });

  it('reports an already-canonical type as not legacy', () => {
    expect(canonicalizeContentType('application/json').wasLegacy).toBe(false);
    expect(canonicalizeContentType('application/problem+json').wasLegacy).toBe(false);
  });
});

describe('COMP-01 pagination canonicalization', () => {
  it('passes canonical limit, cursor and sort through untouched', () => {
    const out = canonicalizePagination('limit=50&cursor=abc&sort=createdAt:desc');
    expect(out).toEqual({
      limit: 50, cursor: 'abc', sort: 'createdAt:desc', wasLegacy: false, offsetNotExpressible: null,
    });
  });

  it('defaults the limit when none was supplied', () => {
    expect(canonicalizePagination('').limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it.each([
    ['per_page', 'per_page=30'],
    ['pageSize', 'pageSize=30'],
  ])('folds the legacy %s into the canonical limit', (_label, query) => {
    const out = canonicalizePagination(query);
    expect(out.limit).toBe(30);
    expect(out.wasLegacy).toBe(true);
    expect(out.offsetNotExpressible).toBeNull();
  });

  it('prefers a canonical limit over the legacy names', () => {
    expect(canonicalizePagination('limit=10&per_page=90').limit).toBe(10);
  });

  it.each([
    ['above the ceiling', 'limit=500', MAX_PAGE_LIMIT],
    ['exactly the ceiling', 'limit=100', MAX_PAGE_LIMIT],
    ['zero', 'limit=0', DEFAULT_PAGE_LIMIT],
    ['negative', 'limit=-5', DEFAULT_PAGE_LIMIT],
    ['fractional', 'limit=10.9', 10],
    ['non-numeric', 'limit=abc', DEFAULT_PAGE_LIMIT],
    ['empty', 'limit=', DEFAULT_PAGE_LIMIT],
  ])('clamps %s', (_label, query, expected) => {
    expect(canonicalizePagination(query).limit).toBe(expected);
  });

  it.each([
    ['page', 'page=2'],
    ['offset', 'offset=20'],
  ])('REPORTS that the legacy %s cannot become a keyset cursor, and does not fabricate one', (_label, query) => {
    const out = canonicalizePagination(query);
    // `page=2` means skip 20 rows; `cursor=X` means start after the row X names.
    // They agree only under a stable ordering, which is exactly the assumption
    // an offset page does not make - so the module refuses the mapping.
    expect(out.offsetNotExpressible).not.toBeNull();
    expect(out.offsetNotExpressible).toContain(query.split('=')[0]!);
    expect(out.cursor).toBeNull();
    expect(out.wasLegacy).toBe(true);
  });

  it('accepts a URLSearchParams as well as a raw query string', () => {
    const out = canonicalizePagination(new URLSearchParams('limit=25&cursor=zz'));
    expect(out.limit).toBe(25);
    expect(out.cursor).toBe('zz');
  });

  it('reports an empty-string param as absent, not as an empty value', () => {
    const out = canonicalizePagination('cursor=&sort=');
    expect(out.cursor).toBeNull();
    expect(out.sort).toBeNull();
  });
});

describe('COMP-01 whole-request canonicalization', () => {
  it('canonicalizes credential, content type and page in one pass', () => {
    const out = canonicalizeRequest(
      { 'X-API-KEY': 'legacy-key', 'Content-Type': 'text/json; charset=utf-8' },
      'page=2&per_page=25',
    );
    expect(out.credential).toEqual({
      scheme: 'api-key', token: 'legacy-key', canonicalHeader: 'x-api-key',
    });
    expect(out.contentType).toBe(CANONICAL_CONTENT_TYPES.json);
    expect(out.pagination.limit).toBe(25);
    expect(out.pagination.offsetNotExpressible).not.toBeNull();
    expect(out.wasLegacy).toBe(true);
  });

  it('reports a fully canonical request as not legacy', () => {
    const out = canonicalizeRequest(
      { authorization: 'Bearer tok', 'content-type': 'application/json' },
      'limit=20',
    );
    expect(out.wasLegacy).toBe(false);
    expect(out.pagination.wasLegacy).toBe(false);
  });

  it('never throws on an empty request', () => {
    const out = canonicalizeRequest({}, '');
    expect(out.credential.token).toBe('');
    expect(out.contentType).toBeNull();
    expect(out.pagination.limit).toBe(DEFAULT_PAGE_LIMIT);
  });
});
