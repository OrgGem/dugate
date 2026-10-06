import {
  PROMPT_OVERRIDE_PRECEDENCE,
  type PinnedProfilePolicy,
  type PromptOverrideRead,
} from '@du/contracts';

/**
 * P730-PREFCONSUME (Δ-C adjudication: "resolve consumer-side từ snapshot
 * (Code > Profile > Connector + _default)") — the consumer-side prompt
 * precedence resolver for document-core action consumers.
 *
 * ## The precedence (frozen order)
 *
 * `PROMPT_OVERRIDE_PRECEDENCE` (`profile-policy.ts`) = `['code','profile',
 * 'connector']`. This module is the ONE place that implements it for prompts:
 *
 *   1. `code`      — the code-injected prompt (`variables._prompt` legacy); a
 *                    trim-empty value is ABSENT, not an override.
 *   2. `profile`   — the PINNED key-4 bucket: exact `(connectionId, stepId)`
 *                    first, then the connection's `_default` row — the same
 *                    exact→`_default` selection `pickPromptOverride`
 *                    (`prompt-overrides.ts:209`) performs. The bucket is the
 *                    already-pinned list (never a live DB read — PRF-02).
 *   3. `connector` — the call-site / connector default. This module NEVER
 *                    applies it: it only LABELS the fall-through
 *                    (`source:'connector_default'|'none'`, `apply:false`) so
 *                    the caller keeps its existing prompt path byte-for-byte.
 *                    A `promptRevisions`-empty pin is NOT a cue to apply a
 *                    connector default (PREP §5 negative; fail-loud, not
 *                    fail-open).
 *
 * ## Load-bearing semantics
 *
 * - **null vs empty = clear.** A row's content is trimmed; `null` and `''`
 *   (and whitespace-only) both mean "no effective override". A CLEARED exact
 *   row still SHORT-CIRCUITS the `_default` row — the selection is
 *   `pickPromptOverride` parity (exact wins over `_default` regardless of
 *   content), and its clear-ness then falls THROUGH to the connector level.
 * - **`profilePolicy === null` is admitted-without-policy**, distinct from an
 *   empty policy: the profile level is skipped entirely and never coalesced
 *   to `{}` (PROMPT-02 / 0026 NULL semantics). `undefined` (pre-pin legacy
 *   operation) behaves the same.
 * - **The bucket is pre-scoped at admission** (`listFor(apiKeyId,
 *   endpointSlug)`), so the consumer only needs `connectionId` + `stepId`;
 *   `apiKeyId`/`endpointSlug` never appear at this layer.
 *
 * ## Wiring status (honest)
 *
 * No production call-site yet, and that is BLOCKED, not forgotten: the pin's
 * content carrier is the OPEN Δ-1 (cc_1 `p745-prompt-producer-prep` §2 —
 * sealed bucket vs snapshot extension; marker-map key format chốt pending).
 * Callers wire this in at the build-prompt step (each `XAction.executeRecipe`)
 * when the carrier lands — the substitution is `resolved.apply ? resolved.prompt : defaultText`.
 */

/** The minimum a pinned override row must expose to be resolved. */
export type PinnedPromptOverride = Pick<
  PromptOverrideRead,
  'connectionId' | 'stepId' | 'promptOverride'
>;

export interface ResolveStepPromptInput {
  /** Legacy code-injected prompt (`variables._prompt`). Trim-empty = absent. */
  codePrompt?: string | null;
  /**
   * The PINNED key-4 bucket, already scoped to (apiKey, endpoint) at
   * admission. `null`/`undefined` = no pin (legacy op) — same outcome as an
   * empty bucket: no profile override, never a fabricated default.
   */
  pinnedOverrides?: readonly PinnedPromptOverride[] | null | undefined;
  /** The bound connection for this step. Required for the profile level. */
  connectionId?: string | null;
  /** The step being executed (exact key-4 lookup; `_default` is the fallback). */
  stepId: string;
  /**
   * The pinned admission policy. `null` = admitted-without-policy (profile
   * level skipped). `undefined` = pre-pin operation (same skip).
   */
  profilePolicy?: PinnedProfilePolicy | null | undefined;
  /**
   * The caller's existing default, used ONLY to label the fall-through
   * (`connector_default` vs `none`). Never applied by this module.
   */
  connectorDefaultPrompt?: string | null;
}

export type ResolvedStepPrompt =
  | { source: 'code'; prompt: string; apply: true }
  | { source: 'profile_exact'; prompt: string; apply: true; matchedStepId: string }
  | { source: 'profile_default'; prompt: string; apply: true; matchedStepId: '_default' }
  | { source: 'connector_default'; prompt: string | null; apply: false }
  | { source: 'none'; prompt: null; apply: false };

const DEFAULT_STEP_ID = '_default';

/** Trim; '' and whitespace-only are absent/cleared, never an override. */
function normalizeContent(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The row this connection + step should use: exact `stepId` first, then the
 * connection's `_default` — `pickPromptOverride` parity (`prompt-overrides.ts:209`),
 * re-expressed locally because document-core cannot import an orchestrator
 * module. Selection is by STEP ONLY; content clear-ness is decided by the
 * caller (a cleared exact row still short-circuits `_default`).
 */
export function pickPinnedPromptOverride(
  bucket: readonly PinnedPromptOverride[] | null | undefined,
  connectionId: string,
  stepId: string
): PinnedPromptOverride | null {
  if (!bucket || bucket.length === 0) return null;
  const exact = bucket.find(
    (row) => row.connectionId === connectionId && row.stepId === stepId
  );
  if (exact) return exact;
  return (
    bucket.find(
      (row) => row.connectionId === connectionId && row.stepId === DEFAULT_STEP_ID
    ) ?? null
  );
}

/**
 * Resolve the effective step prompt under the frozen precedence. The caller
 * SUBSTITUTES only when `apply === true`; otherwise it keeps its existing
 * (call-site) prompt untouched.
 */
export function resolveStepPrompt(input: ResolveStepPromptInput): ResolvedStepPrompt {
  // 1. Code outranks everything (PROMPT_OVERRIDE_PRECEDENCE[0]).
  const code = normalizeContent(input.codePrompt);
  if (code !== null) return { source: 'code', prompt: code, apply: true };

  // 2. Profile — skipped entirely when the operation was admitted without a
  //    policy (null ≠ empty), or when there is no connection to match.
  const profileEligible =
    input.profilePolicy != null &&
    typeof input.connectionId === 'string' &&
    input.connectionId.length > 0;
  if (profileEligible) {
    const selected = pickPinnedPromptOverride(
      input.pinnedOverrides,
      input.connectionId as string,
      input.stepId
    );
    if (selected) {
      const content = normalizeContent(selected.promptOverride);
      if (content !== null) {
        return selected.stepId === DEFAULT_STEP_ID
          ? { source: 'profile_default', prompt: content, apply: true, matchedStepId: DEFAULT_STEP_ID }
          : { source: 'profile_exact', prompt: content, apply: true, matchedStepId: selected.stepId };
      }
      // Cleared row (null/''): no effective PROFILE override — fall through to
      // the connector level. The _default row is NOT resurrected (selection
      // short-circuited at the exact row, pickPromptOverride parity).
    }
  }

  // 3. Connector — labeled, NEVER applied here (PREP §5 negative).
  const connectorDefault = normalizeContent(input.connectorDefaultPrompt);
  return connectorDefault !== null
    ? { source: 'connector_default', prompt: connectorDefault, apply: false }
    : { source: 'none', prompt: null, apply: false };
}

/** Re-export for consumers asserting the frozen order (single source). */
export { PROMPT_OVERRIDE_PRECEDENCE };
