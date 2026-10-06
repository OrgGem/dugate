import { resolveStepPrompt } from './prompt-precedence';
import type { PinnedProfilePolicy, PinnedPromptOverride } from '@du/contracts';

/**
 * P745-CARRIER-IMPL-B2 (T7) — apply the pinned step prompt at a build-prompt
 * site, PC-2(a): `resolved.apply ? resolved.prompt : defaultText`.
 *
 * Precedence and skip semantics are entirely `resolveStepPrompt`'s (Code >
 * Profile exact > Profile `_default` > Connector default); this module only
 * supplies the connection identity and performs the substitution. The caller's
 * existing prompt text is the `connectorDefaultPrompt`, so it is used
 * byte-for-byte whenever the resolver does not apply an override.
 *
 * Δ-2 adjudication (conservative): a step whose connection or stepId cannot be
 * matched EXACTLY keeps its existing text — no binding is ever guessed.
 */

export interface PinnedPromptView {
  readonly promptOverrides?: readonly PinnedPromptOverride[] | null;
  readonly profilePolicy?: PinnedProfilePolicy | null;
  readonly connectorBindings?: Readonly<Record<string, string>>;
}

export interface ApplyStepPromptInput {
  /** Connector slot for this invocation (its binding names the connection). */
  slot: string;
  /** The step being executed (exact key-4 stepId lookup). */
  stepId: string;
  /** The call site's existing prompt text — used unchanged when nothing applies. */
  defaultText: string;
  /** Legacy code-injected prompt (highest precedence); trim-empty = absent. */
  codePrompt?: string | null;
}

/**
 * The connectionId pinned for `slot`, from the claim's connectorBindings
 * (`"connectorId@revision"`, the documented wire format). Returns null when
 * the slot has no binding — the caller then skips the profile level rather
 * than guessing a connection.
 */
export function connectionIdForSlot(ctx: PinnedPromptView, slot: string): string | null {
  const binding = ctx.connectorBindings?.[slot];
  if (typeof binding !== 'string' || binding.trim().length === 0) return null;
  const at = binding.indexOf('@');
  const id = (at >= 0 ? binding.slice(0, at) : binding).trim();
  return id.length > 0 ? id : null;
}

/**
 * Resolve the effective prompt for a step and substitute it for `defaultText`
 * only when the resolver says to apply. Never fabricates a prompt and never
 * touches the connector default path.
 */
export function applyPinnedStepPrompt(ctx: PinnedPromptView, input: ApplyStepPromptInput): string {
  const resolved = resolveStepPrompt({
    codePrompt: input.codePrompt,
    pinnedOverrides: ctx.promptOverrides,
    connectionId: connectionIdForSlot(ctx, input.slot),
    stepId: input.stepId,
    profilePolicy: ctx.profilePolicy,
    connectorDefaultPrompt: input.defaultText,
  });
  return resolved.apply && typeof resolved.prompt === 'string' ? resolved.prompt : input.defaultText;
}
