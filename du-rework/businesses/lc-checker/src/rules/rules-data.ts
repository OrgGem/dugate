import type { LcRule, LcTriggerRule, RuleSetStatus } from './rule-types';
import { LC_AUTHORITY_RULES } from './rules-authorities';
import { LC_CHECKLIST_RULES, LC_ENFORCEMENT_RULES, LC_SEVERITY_RULES, LC_TRIGGER_RULES } from './rules-examinations';
import { LC_HOUSE_RULES } from './rules-house';

export const LC_RULESET_ID = 'lc-rules-base' as const;
export const LC_RULESET_VERSION = 'ucp600-isbp821-v1' as const;
export const LC_RULESET_STATUS: RuleSetStatus = 'PROVISIONAL';
export const LC_RULESET_PROVENANCE =
  'verbatim port of lib/pipelines/workflows/prompts/lc-checker-prompts.ts (DUGate legacy rules base: UCP 600, ISBP 821 2013, eUCP v2.0)';

export { LC_TRIGGER_RULES };
export type { LcRule, LcTriggerRule, RuleSetStatus };

/** Every rule in the base, in examination order: house rules, authorities, then process. */
export const LC_RULES: readonly LcRule[] = [
  ...LC_HOUSE_RULES,
  ...LC_CHECKLIST_RULES,
  ...LC_AUTHORITY_RULES,
  ...LC_ENFORCEMENT_RULES,
  ...LC_SEVERITY_RULES,
];
