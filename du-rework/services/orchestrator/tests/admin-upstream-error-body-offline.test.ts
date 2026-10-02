/**
 * CONV-05 — the shared upstream error-body sanitiser.
 *
 * This helper replaced six local copies that were byte-identical modulo their
 * names, so these tests pin the behaviour the copies had — including the one
 * thing the helper deliberately does NOT do. A suite that only checked
 * "control characters are stripped" would still pass if someone later added a
 * redaction step that silently changed what an operator sees, so that boundary
 * is pinned explicitly.
 */
import {
  sanitizeUpstreamErrorBody,
  UPSTREAM_ERROR_BODY_MAX_CHARS,
} from '../src/app/admin/upstream-error-body';

describe('CONV-05 sanitizeUpstreamErrorBody', () => {
  it('caps the echoed body at 256 characters', () => {
    expect(UPSTREAM_ERROR_BODY_MAX_CHARS).toBe(256);
    const out = sanitizeUpstreamErrorBody('x'.repeat(1000));
    expect(out).toHaveLength(256);
    expect(out).toBe('x'.repeat(256));
  });

  it('replaces control characters with spaces so an upstream cannot inject layout', () => {
    // The sentinels are INJECTED here on purpose: an assertion that a marker is
    // absent from the output only proves something when it was present in the
    // input.
    const injected = 'bad\nheader\r\n\u001b[31mred\u0000\u007fend';
    const out = sanitizeUpstreamErrorBody(injected);

    expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(out).toBe(injected.replace(/[\u0000-\u001f\u007f]/g, ' '));
  });

  it('stays bounded when the whole body is control characters', () => {
    const out = sanitizeUpstreamErrorBody('a'.repeat(200) + '\u0000'.repeat(200));
    expect(out).toHaveLength(UPSTREAM_ERROR_BODY_MAX_CHARS);
    expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('returns empty for empty input, so a caller never emits a dangling colon', () => {
    const body = sanitizeUpstreamErrorBody('');
    expect(body).toBe('');
    // The exact shape every fetcher composes around this helper.
    expect(`Platform returned HTTP 500${body ? `: ${body}` : ''}`).toBe('Platform returned HTTP 500');
  });

  it('does NOT redact: the boundary is bounded-and-printable, not scrubbed', () => {
    // This pins the honest limit of the helper. If a future change starts
    // masking secrets here, the operator-facing message changes silently — and
    // this test fails instead of letting that pass unnoticed.
    const secret = 'token=sk-live-abcdef123456';
    expect(sanitizeUpstreamErrorBody(`upstream said ${secret}`)).toBe(`upstream said ${secret}`);
  });
});
