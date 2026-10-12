import { resolveStepPrompt } from './prompt-precedence';
import type { PinnedProfilePolicy, PinnedPromptOverride, TenantDefaultsSnapshot } from '@du/contracts';
import type { SupportedFormat } from '@du/document-kit';
import { STEP_KEYS } from '../recipes/step-keys';

/**
 * P745-CARRIER-IMPL-B2 (T7) — apply the pinned step prompt at a build-prompt
 * site, PC-2(a): `resolved.apply ? resolved.prompt : defaultText`.
 *
 * Precedence and skip semantics are entirely `resolveStepPrompt`'s (Code >
 * Profile exact > Profile `_default` > tenant category > Connector default).
 * This module supplies the pinned connection identity and performs any
 * tenant-template substitution. The caller's existing prompt text remains the
 * final fallback and is used byte-for-byte when no admitted override applies.
 *
 * Δ-2 adjudication (conservative): a step whose connection or stepId cannot be
 * matched EXACTLY keeps its existing text — no binding is ever guessed.
 */

export interface PinnedPromptView {
  readonly promptOverrides?: readonly PinnedPromptOverride[] | null;
  readonly profilePolicy?: PinnedProfilePolicy | null;
  readonly connectorBindings?: Readonly<Record<string, string>>;
  readonly tenantDefaults?: TenantDefaultsSnapshot | null;
}

export type TenantPromptCategory = 'image' | 'pdf' | 'docx' | 'compare' | 'generate';

const CATEGORY_STEPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ingest: Object.freeze([STEP_KEYS.INGEST.EXECUTE_OCR, STEP_KEYS.INGEST.EXECUTE_DIGITIZE]),
  extract: Object.freeze([STEP_KEYS.EXTRACT.CONNECTOR_INFERENCE]),
  analyze: Object.freeze([
    STEP_KEYS.ANALYZE.CONNECTOR_INFERENCE,
    STEP_KEYS.ANALYZE.FACT_CHECK_EXTRACT_CLAIMS,
    STEP_KEYS.ANALYZE.FACT_CHECK_VERIFY_CLAIMS,
    STEP_KEYS.ANALYZE.SUMMARIZE_EVAL_INFERENCE,
  ]),
  transform: Object.freeze([STEP_KEYS.TRANSFORM.EXECUTE_TRANSLATE, STEP_KEYS.TRANSFORM.EXECUTE_REWRITE]),
});

const IMAGE_FORMATS = ['png', 'jpeg', 'tiff', 'webp'] as const;

/**
 * Choose a tenant prompt slot only for a registered action/step pair. Compare
 * and generate use their dedicated categories; document actions require every
 * authorized source artifact to have the same content-detected category.
 */
export function resolveTenantPromptCategory(
  action: string,
  stepId: string,
  sourceFormats: readonly SupportedFormat[],
): TenantPromptCategory | null {
  if (!isTenantPromptStep(action, stepId)) return null;
  if (
    action === 'compare' &&
    (stepId === STEP_KEYS.COMPARE.EXECUTE_SEMANTIC || stepId === STEP_KEYS.COMPARE.EXECUTE_VERSION)
  ) {
    return 'compare';
  }
  if (action === 'generate' && stepId === STEP_KEYS.GENERATE.CONNECTOR_INFERENCE) return 'generate';
  if (sourceFormats.length === 0) return null;

  const categories = sourceFormats.map((format): TenantPromptCategory | null => {
    if (format === 'pdf') return 'pdf';
    if (format === 'docx') return 'docx';
    if ((IMAGE_FORMATS as readonly string[]).includes(format)) return 'image';
    return null;
  });
  if (categories.some((category) => category === null)) return null;
  const distinct = new Set(categories);
  return distinct.size === 1 ? categories[0] ?? null : null;
}

export function isTenantPromptStep(action: string, stepId: string): boolean {
  if (
    action === 'compare' &&
    (stepId === STEP_KEYS.COMPARE.EXECUTE_SEMANTIC || stepId === STEP_KEYS.COMPARE.EXECUTE_VERSION)
  ) {
    return true;
  }
  if (action === 'generate' && stepId === STEP_KEYS.GENERATE.CONNECTOR_INFERENCE) return true;
  return CATEGORY_STEPS[action]?.includes(stepId) ?? false;
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
  /** Category derived from the registered action and its authorized inputs. */
  tenantPromptCategory?: TenantPromptCategory;
  /** Trusted values used only to fill tokens in the selected tenant template. */
  tenantPromptVariables?: Readonly<Record<string, string>>;
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
    tenantDefaultPrompt: input.tenantPromptCategory
      ? ctx.tenantDefaults?.prompts[input.tenantPromptCategory]
      : undefined,
    connectorDefaultPrompt: input.defaultText,
  });
  if (!resolved.apply || typeof resolved.prompt !== 'string') return input.defaultText;
  return resolved.source === 'tenant_default'
    ? interpolateTenantPrompt(resolved.prompt, input.tenantPromptVariables)
    : resolved.prompt;
}

function interpolateTenantPrompt(
  template: string,
  variables: Readonly<Record<string, string>> | undefined,
): string {
  if (!variables) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (token, name: string) =>
    Object.hasOwn(variables, name) ? variables[name] ?? token : token,
  );
}
