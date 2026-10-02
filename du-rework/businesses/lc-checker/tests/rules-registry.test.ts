import {
  LC_ALL_RULES,
  LC_DEFAULT_RULE_SET_VERSION,
  LC_RULE_SETS,
  LC_RULE_SET_PROVENANCE,
  LC_RULE_SET_STATUS,
  LC_TRIGGERS,
  getRule,
  getRuleSet,
  hasRule,
  listRuleIds,
  listTriggerRuleIds,
} from '../src/rules/rule-registry';
import {
  buildAdjudicationPrompt,
  buildInspectionPrompt,
  buildScreenPrompt,
  renderRulesetPrompt,
} from '../src/rules/prompt-builders';
import { buildOcrPrompt } from '../src/rules/ocr-prompt';

describe('P9-02 rules base', () => {
  it('ships exactly one versioned ruleset and resolves it by version', () => {
    expect(Object.keys(LC_RULE_SETS)).toEqual([LC_DEFAULT_RULE_SET_VERSION]);
    const ruleSet = getRuleSet(LC_DEFAULT_RULE_SET_VERSION);
    expect(ruleSet).toBeDefined();
    expect(ruleSet?.status).toBe('PROVISIONAL');
  });

  it('never falls back when an unknown version is requested', () => {
    expect(getRuleSet('ucp600-isbp821-v99')).toBeUndefined();
    expect(getRuleSet('')).toBeUndefined();
  });

  it('records where the rules came from, so a reviewer can diff against the source', () => {
    expect(LC_RULE_SET_PROVENANCE).toContain('lc-checker-prompts.ts');
    expect(LC_RULE_SET_STATUS).toBe('PROVISIONAL');
  });

  it('has no duplicate rule ids', () => {
    const ids = LC_ALL_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate trigger ids', () => {
    const ids = LC_TRIGGERS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(listTriggerRuleIds());
  });

  it('carries the categories the legacy prompt declared, in order', () => {
    const categories = new Set(LC_ALL_RULES.map((rule) => rule.category));
    expect([...categories].sort()).toEqual([
      'core-logic',
      'document-checklist',
      'enforcement',
      'exclusion',
      'isbp821',
      'meta',
      'procedure',
      'severity',
      'ucp600',
    ]);
  });

  it('covers the UCP 600 articles the legacy rules base cited', () => {
    for (const article of [3, 14, 17, 18, 19, 20, 22, 23, 26, 27, 28, 29, 30, 31, 32]) {
      expect(hasRule('UCP600-ART-' + article)).toBe(true);
    }
  });

  it('covers every EX exclusion and the four meta rules', () => {
    for (let index = 1; index <= 7; index += 1) {
      expect(hasRule('EX-' + index)).toBe(true);
    }
    for (let index = 1; index <= 4; index += 1) {
      expect(hasRule('MR-' + index)).toBe(true);
    }
  });

  it('keeps the 15 conditional triggers of the legacy EM-2 table', () => {
    expect(listTriggerRuleIds()).toHaveLength(15);
    expect(getRuleSet(LC_DEFAULT_RULE_SET_VERSION)?.rules.length).toBeGreaterThanOrEqual(60);
  });

  it('gives every checklist rule at least one item', () => {
    const checklists = LC_ALL_RULES.filter((rule) => rule.category === 'document-checklist');
    expect(checklists.length).toBeGreaterThanOrEqual(6);
    for (const rule of checklists) {
      expect(rule.items?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('resolves a rule by id and returns undefined for an unknown one', () => {
    expect(getRule('UCP600-ART-28')?.citation).toBe('UCP 600 Art. 28');
    expect(getRule('UCP600-ART-99')).toBeUndefined();
  });

  it('renders every rule id into the compliance prompt, so any citation resolves', () => {
    const ruleSet = getRuleSet(LC_DEFAULT_RULE_SET_VERSION);
    expect(ruleSet).toBeDefined();
    const prompt = renderRulesetPrompt(ruleSet!);
    for (const id of listRuleIds()) {
      expect(prompt).toContain('[' + id + ']');
    }
  });

  it('renders the trigger table and the output contract into the prompt', () => {
    const ruleSet = getRuleSet(LC_DEFAULT_RULE_SET_VERSION);
    const prompt = renderRulesetPrompt(ruleSet!);
    for (const id of listTriggerRuleIds()) {
      expect(prompt).toContain('| ' + id + ' |');
    }
    expect(prompt).toContain('rule_id');
    expect(prompt).toContain('ruleset_status: PROVISIONAL');
  });

  it('embeds the ruleset identity so the examiner knows which base it is under', () => {
    const prompt = buildScreenPrompt({
      fileCount: 2,
      ocrTexts: new Map([['invoice.pdf', 'INVOICE']]),
      fileNames: ['invoice.pdf', 'bill-of-lading.pdf'],
      ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
      maxVisualRequests: 24,
    });
    expect(prompt).toContain('ruleset_version: ' + LC_DEFAULT_RULE_SET_VERSION);
    expect(prompt).toContain('2 file(s) submitted for examination');
    expect(prompt).toContain('[DOC 0] invoice.pdf');
    expect(prompt).toContain('SCREENING pass');
  });

  it('refuses to build a prompt for a ruleset that does not exist', () => {
    expect(() =>
      buildScreenPrompt({
        fileCount: 1,
        ocrTexts: new Map(),
        fileNames: ['a.pdf'],
        ruleSetVersion: 'nope',
        maxVisualRequests: 24,
      })
    ).toThrow('Unknown LC ruleset version nope');
  });

  it('renders only the cited rules into an inspection prompt, keeping the second pass cheap', () => {
    const prompt = buildInspectionPrompt({
      fileName: 'bill-of-lading.pdf',
      documentIndex: 1,
      purpose: 'Is the bill of lading endorsed on the reverse?',
      ruleIds: ['PROC-3.8'],
      ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
    });
    expect(prompt).toContain('[PROC-3.8]');
    expect(prompt).toContain('Is the bill of lading endorsed on the reverse?');
    expect(prompt).not.toContain('[UCP600-ART-28]');
    expect(prompt).toContain('observations');
  });

  it('refuses an inspection prompt that cites a rule outside the rules base', () => {
    expect(() =>
      buildInspectionPrompt({
        fileName: 'b.pdf',
        documentIndex: 0,
        purpose: 'x',
        ruleIds: ['MADE-UP'],
        ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
      })
    ).toThrow('cites rule MADE-UP');
  });

  it('tells the adjudicator which questions nobody answered, so no clean verdict is possible', () => {
    const prompt = buildAdjudicationPrompt({
      fileCount: 2,
      ocrTexts: new Map(),
      fileNames: ['invoice.pdf', 'bill-of-lading.pdf'],
      visualDigests: [],
      screenNotes: 'endorsement unreadable',
      outstandingChecks: [
        { documentIndex: 1, purpose: 'Is the bill of lading endorsed on the reverse?', ruleIds: ['PROC-3.8'] },
      ],
      ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
    });
    expect(prompt).toContain('UNSATISFIED VISUAL CHECKS');
    expect(prompt).toContain('You may NOT return COMPLIANT');
  });

  it('omits the unsatisfied section entirely when every check came back', () => {
    const prompt = buildAdjudicationPrompt({
      fileCount: 2,
      ocrTexts: new Map(),
      fileNames: ['invoice.pdf', 'bill-of-lading.pdf'],
      visualDigests: [
        {
          documentIndex: 1,
          fileName: 'bill-of-lading.pdf',
          purpose: 'Is the bill of lading endorsed on the reverse?',
          ruleIds: ['PROC-3.8'],
          observations: [{ field: 'shipper endorsement', found: true, evidence: 'page 3' }],
        },
      ],
      screenNotes: 'ok',
      outstandingChecks: [],
      ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
    });
    expect(prompt).not.toContain('UNSATISFIED VISUAL CHECKS');
    expect(prompt).toContain('VISUAL INSPECTION: bill-of-lading.pdf');
    expect(prompt).toContain('shipper endorsement: PRESENT');
  });

  it('keeps the ruleset identity even when an operator override replaces the base', () => {
    const prompt = buildScreenPrompt({
      fileCount: 1,
      ocrTexts: new Map(),
      fileNames: ['a.pdf'],
      ruleSetVersion: LC_DEFAULT_RULE_SET_VERSION,
      maxVisualRequests: 24,
      promptOverride: 'do it my way',
    });
    expect(prompt).toContain('OPERATOR OVERRIDE');
    expect(prompt).toContain('ruleset_version: ' + LC_DEFAULT_RULE_SET_VERSION);
    expect(prompt).not.toContain('[UCP600-ART-28]');
  });

  it('builds an OCR prompt that is not a rule, so it carries no authority', () => {
    const prompt = buildOcrPrompt('bill-of-lading.pdf');
    expect(prompt).toContain('bill-of-lading.pdf');
    expect(prompt).toContain('VERBATIM FIDELITY');
    expect(listRuleIds()).not.toContain('OCR-PROMPT');
  });
});
