export type RuleCategory =
  | 'meta'
  | 'core-logic'
  | 'exclusion'
  | 'procedure'
  | 'document-checklist'
  | 'ucp600'
  | 'isbp821'
  | 'enforcement'
  | 'severity';

/** Only PROVISIONAL exists. A CONFIRMED status requires a domain-owner signature. */
export type RuleSetStatus = 'PROVISIONAL';

export interface LcRule {
  /** Stable identifier. Cited verbatim by `LcDiscrepancy.ruleId`. Never renumber. */
  readonly id: string;
  readonly category: RuleCategory;
  /** Human-readable authority, e.g. "UCP 600 Art. 28(f)". Null for house rules. */
  readonly citation: string | null;
  /** The rule itself, transcribed from the legacy prompt. */
  readonly text: string;
  /** Extra checklist items belonging to this rule, for document-checklist entries. */
  readonly items?: readonly string[];
}

export interface LcRuleSet {
  readonly id: string;
  readonly version: string;
  readonly status: RuleSetStatus;
  /** Where this rules base came from, so a reviewer can diff it against the source. */
  readonly provenance: string;
  readonly rules: readonly LcRule[];
}

/** A conditional trigger from the legacy EM-2 table. `condition` names an intermediate finding. */
export interface LcTriggerRule {
  readonly id: string;
  readonly condition: string;
  readonly action: string;
}

export function defineRule(
  id: string,
  category: RuleCategory,
  citation: string | null,
  text: string,
  items?: readonly string[]
): LcRule {
  return items === undefined ? { id, category, citation, text } : { id, category, citation, text, items };
}
