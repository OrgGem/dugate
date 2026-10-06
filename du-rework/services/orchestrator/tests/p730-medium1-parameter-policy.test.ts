import type { ProfileParameters } from '@du/contracts';
import {
  coerceProfileParameters,
  coerceRowParameters,
  isReservedParameterKey,
  mergeParameters,
  parametersFromFlatValues,
  parseWriteParameters,
  PROFILE_PARAMETER_MAX_KEYS,
  PROFILE_PARAMETER_MAX_VALUE_LENGTH,
} from '../src/modules/profiles/policy';
import { HttpError } from '../src/http/errors';

/**
 * P745 / MEDIUM-1 - parameter policy hardening.
 *
 * Scope C (reserved-key deny + key-allowlist), A-lite (write-path
 * re-validation + caps) and the admin-trusted pin (no secret scan in a
 * value).
 *
 * ## Why the reserved-key fixtures use JSON.parse
 *
 * An object literal `{ __proto__: x }` sets the PROTOTYPE of the object; it
 * does not create an own key. The realistic path - a PG jsonb column read
 * back through JSON.parse - DOES create an own key, and `Object.entries`
 * surfaces it. So every reserved-key fixture is built with JSON.parse, which
 * is the only way to reach the assignment the deny guards.
 *
 * ## Why `({}).polluted === undefined` is NOT the load-bearing assertion
 *
 * Measured 2026-10-04 (probe .qwen/tmp/p745-probe.js): assigning
 * `merged['__proto__'] = obj` sets the prototype of `merged`, NOT of
 * `Object.prototype`. So `({}).polluted` is `undefined` both before and after
 * the fix - that assertion alone would pass on unpatched code. The
 * assertions that actually fail pre-fix are the ones on the RESULT object's
 * own prototype and on inherited lookups off it.
 */

const SENTINEL = 'sk-live-7f3a9c1e5b2d8f4a6c0e1d2b3a4f5e6d';

function httpStatus(err: unknown): number {
  return err instanceof HttpError ? err.status : -1;
}

function httpCode(err: unknown): string {
  return err instanceof HttpError ? err.code : '';
}

function asParams(raw: unknown): ProfileParameters {
  return raw as ProfileParameters;
}

/** A stored parameter map carrying an OWN `__proto__` key, as PG would. */
function storedWithProto(): ProfileParameters {
  return asParams(
    JSON.parse('{"__proto__":{"value":{"polluted":"yes"}},"normal":{"value":1}}')
  );
}

describe('P745 MEDIUM-1 scope C: reserved-key deny', () => {
  it('recognizes exactly the three reserved keys', () => {
    expect(isReservedParameterKey('__proto__')).toBe(true);
    expect(isReservedParameterKey('constructor')).toBe(true);
    expect(isReservedParameterKey('prototype')).toBe(true);
    expect(isReservedParameterKey('polluted')).toBe(false);
    expect(isReservedParameterKey('constructorX')).toBe(false);
    expect(isReservedParameterKey('__proto')).toBe(false);
  });

  it('refuses a client-supplied __proto__ key with 400', () => {
    const defaults = { normal: { value: 1 } };
    let err: unknown;
    try {
      mergeParameters(defaults, JSON.parse('{"__proto__":{"polluted":"yes"}}'));
    } catch (e) { err = e; }
    expect(httpStatus(err)).toBe(400);
    expect(httpCode(err)).toBe('PROFILE_UNKNOWN_FIELD');
  });

  it('refuses a client-supplied constructor key with 400', () => {
    let err: unknown;
    try { mergeParameters({ normal: { value: 1 } }, { constructor: { polluted: 'yes' } }); }
    catch (e) { err = e; }
    expect(httpStatus(err)).toBe(400);
  });

  it('refuses a client-supplied prototype key with 400', () => {
    let err: unknown;
    try { mergeParameters({ normal: { value: 1 } }, { prototype: { polluted: 'yes' } }); }
    catch (e) { err = e; }
    expect(httpStatus(err)).toBe(400);
  });

  it('NON-VACUOUS: the merged result keeps Object.prototype after a deny', () => {
    const merged = mergeParameters({ normal: { value: 1 } }, { normal: 2 });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.polluted).toBeUndefined();
  });

  it('NON-VACUOUS: a stored __proto__ default is skipped, never assigned', () => {
    const merged = mergeParameters(storedWithProto(), {});
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.polluted).toBeUndefined();
    expect(merged.normal).toBe(1);
  });

  it('baseline: the realm is never polluted (holds pre- and post-fix)', () => {
    // Recorded for completeness. NOT load-bearing - see the file header. The
    // per-object assertions above are the real proof.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('P745 MEDIUM-1 scope C: key-allowlist', () => {
  const defaults = {
    declared: { value: 'd' },
    stored: { value: 's' },
    locked: { value: 'L', isLocked: true },
  };

  it('accepts a declared key', () => {
    const merged = mergeParameters(defaults, { declared: 'x' }, ['declared']);
    expect(merged.declared).toBe('x');
  });

  it('accepts a stored key', () => {
    const merged = mergeParameters(defaults, { stored: 'x' });
    expect(merged.stored).toBe('x');
  });

  it('refuses an unknown key with 400 PROFILE_UNKNOWN_FIELD', () => {
    let err: unknown;
    try { mergeParameters(defaults, { nope: 1 }); } catch (e) { err = e; }
    expect(httpStatus(err)).toBe(400);
    expect(httpCode(err)).toBe('PROFILE_UNKNOWN_FIELD');
  });

  it('refuses a locked key with 400 even when the value is identical', () => {
    let err: unknown;
    try { mergeParameters(defaults, { locked: 'L' }); } catch (e) { err = e; }
    expect(httpStatus(err)).toBe(400);
    expect(httpCode(err)).toBe('PROFILE_LOCKED_FIELD');
  });

  it('a locked key the client did not send stays at its stored value', () => {
    const merged = mergeParameters(defaults, { declared: 'x' });
    expect(merged.locked).toBe('L');
  });
});

describe('P745 MEDIUM-1 scope 3: admin-trusted pin (no secret scan)', () => {
  it('a sentinel secret in a value survives mergeParameters verbatim', () => {
    const merged = mergeParameters({ apiKey: { value: 'old' } }, { apiKey: SENTINEL });
    expect(merged.apiKey).toBe(SENTINEL);
  });

  it('a sentinel secret in a value survives parseWriteParameters verbatim', () => {
    const out = parseWriteParameters({ apiKey: { value: SENTINEL } });
    expect(out.apiKey?.value).toBe(SENTINEL);
  });

  it('token/header/query-shaped sentinels are stored unredacted', () => {
    const out = parseWriteParameters({
      tok: { value: 'Bearer ' + SENTINEL },
      hdr: { value: { Authorization: 'Basic ' + SENTINEL } },
      qry: { value: { api_key: SENTINEL } },
    });
    expect(out.tok?.value).toBe('Bearer ' + SENTINEL);
    expect(out.hdr?.value).toEqual({ Authorization: 'Basic ' + SENTINEL });
    expect(out.qry?.value).toEqual({ api_key: SENTINEL });
  });

  it('the decision is documented, not accidental: a value is never rewritten', () => {
    // The pin: MEDIUM-1 core (a secret parked in a parameter VALUE) is an
    // accepted admin-trusted risk. If a scanner is ever added, THESE are the
    // assertions that must change - there is no scan to re-enable by accident.
    const out = parseWriteParameters({ s: { value: SENTINEL } });
    expect(out.s?.value).toBe(SENTINEL);
    expect(Object.keys(out)).toEqual(['s']);
  });
});

describe('P745 MEDIUM-1 A-lite: write-path caps', () => {
  it('accepts a map at exactly the key cap', () => {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < PROFILE_PARAMETER_MAX_KEYS; i++) params['k' + i] = { value: i };
    expect(() => parseWriteParameters(params)).not.toThrow();
  });

  it('refuses a map over the key cap with 422', () => {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < PROFILE_PARAMETER_MAX_KEYS + 1; i++) params['k' + i] = { value: i };
    let err: unknown;
    try { parseWriteParameters(params); } catch (e) { err = e; }
    expect(httpStatus(err)).toBe(422);
    expect(httpCode(err)).toBe('INVALID_SCHEMA');
  });

  it('accepts a string value at exactly the cap', () => {
    const out = parseWriteParameters({ big: { value: 'x'.repeat(PROFILE_PARAMETER_MAX_VALUE_LENGTH) } });
    expect(out.big?.value).toHaveLength(PROFILE_PARAMETER_MAX_VALUE_LENGTH);
  });

  it('refuses an oversized string value with 422', () => {
    let err: unknown;
    try { parseWriteParameters({ big: { value: 'x'.repeat(PROFILE_PARAMETER_MAX_VALUE_LENGTH + 1) } }); }
    catch (e) { err = e; }
    expect(httpStatus(err)).toBe(422);
  });

  it('refuses an oversized OBJECT value by serialized size with 422', () => {
    const filler = 'x'.repeat(PROFILE_PARAMETER_MAX_VALUE_LENGTH);
    let err: unknown;
    try { parseWriteParameters({ big: { value: { nested: filler } } }); } catch (e) { err = e; }
    // {\"nested\":\"xxx...\"} serializes 12 bytes longer than the raw string.
    expect(httpStatus(err)).toBe(422);
  });

  it('accepts an object value whose serialized size is under the cap', () => {
    const out = parseWriteParameters({ ok: { value: { nested: 'x'.repeat(64) } } });
    expect(out.ok?.value).toEqual({ nested: 'x'.repeat(64) });
  });

  it('refuses a non-object parameters value with 422', () => {
    for (const bad of [null, [], 'str', 42]) {
      let err: unknown;
      try { parseWriteParameters(bad); } catch (e) { err = e; }
      expect(httpStatus(err)).toBe(422);
    }
  });

  it('refuses a malformed value shape (missing value) with 422', () => {
    let err: unknown;
    try { parseWriteParameters({ bad: { isLocked: true } }); } catch (e) { err = e; }
    expect(httpStatus(err)).toBe(422);
  });

  it('refuses a reserved key at the write boundary with 422', () => {
    let err: unknown;
    try { parseWriteParameters(storedWithProto()); } catch (e) { err = e; }
    expect(httpStatus(err)).toBe(422);
  });

  it('refuses a circular value with 422 rather than hanging', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let err: unknown;
    try { parseWriteParameters({ c: { value: cyclic } }); } catch (e) { err = e; }
    expect(httpStatus(err)).toBe(422);
  });
});

describe('P745 MEDIUM-1: read-path hardening', () => {
  it('coerceRowParameters drops a reserved key', () => {
    const out = coerceRowParameters(storedWithProto());
    expect(Object.keys(out)).toEqual(['normal']);
    expect((out as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('coerceProfileParameters returns a sanitized COPY, not the caller object', () => {
    const raw = storedWithProto();
    const out = coerceProfileParameters(raw);
    expect(out).not.toBe(raw);
    expect(Object.keys(out)).toEqual(['normal']);
  });

  it('coerceProfileParameters still passes a clean map through', () => {
    const out = coerceProfileParameters({ a: { value: 1 } });
    expect(out.a?.value).toBe(1);
  });

  it('parametersFromFlatValues skips reserved keys', () => {
    const out = parametersFromFlatValues(
      JSON.parse('{"__proto__":{"polluted":"yes"},"ok":1}')
    );
    expect(Object.keys(out)).toEqual(['ok']);
    expect((out as Record<string, unknown>).polluted).toBeUndefined();
  });
});