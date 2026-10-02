/**
 * P9-02 — types and lookup for the LC rules base.
 *
 * The legacy implementation carried the whole rules base as one interpolated string
 * inside a prompt builder. That made the rules unreferenceable: a discrepancy could say
 * "rule_reference: UCP 600 Art. 28" but nothing could check that the article existed, that
 * it still said what it said, or that two runs were examined against the same base.
 * `LcDiscrepancy.ruleId` is required and resolved against this registry, so an uncited
 * or unknown rule is a validation failure rather than prose.
 *
 * PROVENANCE IS VERBATIM. Every rule is transcribed from the production legacy prompt at
 * lib/pipelines/workflows/prompts/lc-checker-prompts.ts (DUGate legacy). No rule has been
 * added, merged, reworded or "improved". New criteria are a new ruleset version, never an
 * edit to an existing one.
 *
 * STATUS IS PROVISIONAL. P9-02 acceptance requires criteria and rule versions confirmed
 * by a domain owner, and that confirmation does not exist yet. The status travels with the
 * evidence into every result, so a consumer cannot mistake a ported rules base for an
 * authoritative one.
 */

import { LC_RULES, LC_RULESET_ID, LC_RULESET_PROVENANCE, LC_RULESET_STATUS, LC_RULESET_VERSION, LC_TRIGGER_RULES } from './rules-data';
import type { LcRule, LcRuleSet, LcTriggerRule, RuleCategory, RuleSetStatus } from './rule-types';

export type { LcRule, LcRuleSet, LcTriggerRule, RuleCategory, RuleSetStatus };

export const LC_RULE_SET_ID = LC_RULESET_ID;
export const LC_DEFAULT_RULE_SET_VERSION = LC_RULESET_VERSION;
export const LC_RULE_SET_STATUS = LC_RULESET_STATUS;
export const LC_RULE_SET_PROVENANCE = LC_RULESET_PROVENANCE;
export const LC_ALL_RULES = LC_RULES;
export const LC_TRIGGERS = LC_TRIGGER_RULES;

/** The single rules base this business version ships. */
export const LC_RULE_SETS: Readonly<Record<string, LcRuleSet>> = {
  [LC_RULESET_VERSION]: {
    id: LC_RULESET_ID,
    version: LC_RULESET_VERSION,
    status: LC_RULESET_STATUS,
    provenance: LC_RULESET_PROVENANCE,
    rules: LC_RULES,
  },
};

const RULE_INDEX: ReadonlyMap<string, LcRule> = new Map(LC_RULES.map((entry) => [entry.id, entry]));

/** Resolving an unknown version is an error, never a silent fallback to "the only one". */
export function getRuleSet(version: string): LcRuleSet | undefined {
  return LC_RULE_SETS[version];
}

export function hasRule(ruleId: string): boolean {
  return RULE_INDEX.has(ruleId);
}

export function getRule(ruleId: string): LcRule | undefined {
  return RULE_INDEX.get(ruleId);
}

/** Every rule id in this registry, sorted. */
export function listRuleIds(): readonly string[] {
  return [...RULE_INDEX.keys()].sort();
}

export function listTriggerRuleIds(): readonly string[] {
  return LC_TRIGGER_RULES.map((entry) => entry.id);
}
