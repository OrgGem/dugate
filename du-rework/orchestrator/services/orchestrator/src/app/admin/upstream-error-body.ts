/**
 * CONV-05 — shared sanitiser for UPSTREAM error bodies.
 *
 * Six admin section fetchers each carried their own copy of this function (four
 * named `readErrorBody`, two named `sanitiseErrorBody`). The six bodies were
 * extracted and compared before anything was removed: all six are
 * `if (!text) return ''` followed by the same 256-char slice and the same
 * control-character strip, so this module is a de-duplication, not a change of
 * behaviour.
 *
 * The policy is exactly two rules, and deliberately no more:
 * - bounded — a noisy or hostile upstream cannot bloat the shell's response;
 * - printable — control characters (C0 + DEL) become spaces, so an upstream
 *   cannot inject newlines or terminal escapes into an operator-facing message.
 *
 * It does NOT redact, mask or interpret. An upstream secret inside those first
 * 256 characters still reaches the operator, which was already true of all six
 * originals. Stronger scrubbing is a per-fetcher decision and belongs beside
 * that fetcher's own error mapping — which is deliberately NOT shared; see the
 * CONV-D02 exception in the receipt.
 *
 * Spelled `-ize` to match the surrounding admin code (`sanitizeFilterToken`,
 * `sanitizeSortFilter`, `sanitizeAuditSeverityFilter`); the two `-ise` call
 * sites were the minority.
 */

/** Hard cap on how much upstream text is ever echoed to an operator. */
export const UPSTREAM_ERROR_BODY_MAX_CHARS = 256;

/**
 * Bounded, printable rendering of an upstream error body.
 *
 * Empty in, empty out, so a caller composing `body ? ': ' + body : ''` never
 * leaves a dangling colon when the body was empty or unreadable.
 */
export function sanitizeUpstreamErrorBody(text: string): string {
  if (!text) return '';
  return text.slice(0, UPSTREAM_ERROR_BODY_MAX_CHARS).replace(/[\u0000-\u001f\u007f]/g, ' ');
}
