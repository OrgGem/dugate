/**
 * Prompt rendering FROM the rule registry.
 *
 * The legacy workflow had the rules base and the prompt as the same string, so a rule
 * edit was invisible in a diff and a discrepancy could cite an article that no longer
 * said what the run assumed. Here the prompt is DERIVED: the registry is the only source
 * of rule text, and every output contract tells the examiner to cite bracketed rule ids
 * that the registry can resolve. A rule missing from the registry cannot be cited, and
 * the validator rejects the run.
 *
 * Nothing here decides anything. These are strings handed to a connector; examination
 * logic lives in the business and validation lives in validation.ts.
 */

import type { LcComplianceResult, LcVisualDigest, LcVisualRequest } from '../types';
import type { LcRule, LcRuleSet } from './rule-types';
import { LC_TRIGGER_RULES } from './rules-examinations';
import { getRule, getRuleSet } from './rule-registry';

/** Double quote, built rather than written, so the JSON contracts stay readable. */
const Q = String.fromCharCode(34);

const CATEGORY_TITLES: Readonly<Record<string, string>> = {
  meta: 'PHAN 0 - SIEU QUY TAC (META-RULES)',
  'core-logic': 'PHAN 1 - LOGIC LOI HE THONG',
  exclusion: 'PHAN 2 - DANH SACH LOAI TRU',
  procedure: 'PHAN 3 - QUY TRINH THUC THI TUAN TU',
  'document-checklist': 'PHAN 4 - BANG KIEM TRA TUNG LOAI CHUNG TU',
  ucp600: 'PHAN 5 - BO RULES BASE, UCP 600',
  isbp821: 'PHAN 6 - BO RULES BASE, ISBP 821',
  enforcement: 'PHAN 7 - CO CHE CUONG CHE KIEM TRA',
  severity: 'PHAN 8 - SEVERITY VA OUTPUT',
};

const CATEGORY_ORDER: readonly string[] = [
  'meta',
  'core-logic',
  'exclusion',
  'procedure',
  'document-checklist',
  'ucp600',
  'isbp821',
  'enforcement',
  'severity',
];

function renderRule(entry: LcRule): string {
  const head = entry.citation ? '[' + entry.id + '] ' + entry.citation + ':' : '[' + entry.id + ']';
  const lines = [head + ' ' + entry.text];
  if (entry.items && entry.items.length > 0) {
    for (const item of entry.items) {
      lines.push('  - ' + item);
    }
  }
  return lines.join('\n');
}

function renderTriggerTable(): string {
  return [
    '| ID | Dieu kien | Hanh dong bat buoc |',
    '|---|---|---|',
    ...LC_TRIGGER_RULES.map((entry) => '| ' + entry.id + ' | ' + entry.condition + ' | ' + entry.action + ' |'),
  ].join('\n');
}

function renderIdentity(ruleSet: LcRuleSet): string {
  return [
    '=== RULESET IDENTITY ===',
    'ruleset_id: ' + ruleSet.id,
    'ruleset_version: ' + ruleSet.version,
    'ruleset_status: ' + ruleSet.status,
    'ruleset_provenance: ' + ruleSet.provenance,
    'This rules base is the single source of truth for the examination. A finding with no rule_id in this base is not a finding.',
  ].join('\n');
}

const OUTPUT_SCHEMA_LINES: readonly string[] = [
  '{',
  '  ' + Q + 'examination_log' + Q + ': [' + Q + 'GD1: ...' + Q + ', ' + Q + 'GD2-INVOICE: ...' + Q + ', ' + Q + 'GD7: ...' + Q + '],',
  '  ' + Q + 'verdict' + Q + ': ' + Q + 'COMPLIANT | DISCREPANT | PENDING' + Q + ',',
  '  ' + Q + 'total_discrepancies' + Q + ': 0,',
  '  ' + Q + 'major_discrepancies' + Q + ': 0,',
  '  ' + Q + 'minor_discrepancies' + Q + ': 0,',
  '  ' + Q + 'advisory_count' + Q + ': 0,',
  '  ' + Q + 'documents_present' + Q + ': [' + Q + 'Commercial Invoice' + Q + ', ' + Q + 'Bill of Lading' + Q + '],',
  '  ' + Q + 'documents_missing' + Q + ': [],',
  '  ' + Q + 'discrepancies' + Q + ': [',
  '    {',
  '      ' + Q + 'id' + Q + ': ' + Q + 'D001' + Q + ',',
  '      ' + Q + 'severity' + Q + ': ' + Q + 'MAJOR | MINOR | ADVISORY' + Q + ',',
  '      ' + Q + 'document' + Q + ': ' + Q + 'Exact document type label' + Q + ',',
  '      ' + Q + 'field' + Q + ': ' + Q + 'Specific field name' + Q + ',',
  '      ' + Q + 'issue' + Q + ': ' + Q + 'Description of the problem with the values found versus expected' + Q + ',',
  '      ' + Q + 'rule_id' + Q + ': ' + Q + 'id of the rule in this rules base that the deviation comes from' + Q + ',',
  '      ' + Q + 'recommendation' + Q + ': ' + Q + 'Suggested corrective action' + Q,
  '    }',
  '  ],',
  '  ' + Q + 'summary' + Q + ': ' + Q + '2-3 sentence objective summary of the examination result' + Q + ',',
  '  ' + Q + 'recommendation' + Q + ': ' + Q + 'ACCEPT | REJECT | RESERVE_FOR_REVIEW' + Q,
  '}',
];

/** The adjudication output contract, including the rule-id vocabulary. */
export const LC_OUTPUT_CONTRACT = [
  '=== OUTPUT ===',
  'Return ONLY valid JSON, no markdown fences:',
  ...OUTPUT_SCHEMA_LINES,
  'Every ' + Q + 'rule_id' + Q + ' MUST be one of the bracketed rule ids given above, such as UCP600-ART-28 or PROC-3.1.3. An uncited rule is not accepted.',
].join('\n');

/** Render the whole compliance rules base, section by section, from the registry. */
export function renderRulesetPrompt(ruleSet: LcRuleSet): string {
  const sections: string[] = [
    'You are a senior Documentary Credit (LC) checker. You have expert-level knowledge of UCP 600, ISBP 821 (2013 Revision) and eUCP v2.0. Your SOLE task is to examine the attached document set for compliance.',
    renderIdentity(ruleSet),
  ];
  for (const category of CATEGORY_ORDER) {
    const rules = ruleSet.rules.filter((entry) => entry.category === category);
    if (rules.length === 0) continue;
    sections.push('=== ' + (CATEGORY_TITLES[category] ?? category.toUpperCase()) + ' ===');
    sections.push(rules.map(renderRule).join('\n\n'));
    if (category === 'enforcement') {
      sections.push(renderTriggerTable());
    }
  }
  sections.push(LC_OUTPUT_CONTRACT);
  return sections.join('\n\n');
}

function numberedOcrBlock(ocrTexts: ReadonlyMap<string, string>, fileNames: readonly string[]): string {
  if (ocrTexts.size === 0) return '';
  const blocks = fileNames.map((fileName, index) => {
    const text = ocrTexts.get(fileName);
    if (text === undefined) return '[DOC ' + index + '] ' + fileName + '\n(no OCR text recovered)';
    return '[DOC ' + index + '] ' + fileName + '\n' + text;
  });
  return [
    '',
    '=== OCR FULL-TEXT (PRIMARY DATA SOURCE) ===',
    'Dưới đây là toàn bộ nội dung text đã được OCR từ ' + ocrTexts.size + ' file đính kèm.',
    'Mỗi tài liệu được đánh số; document_index trong kết quả là số thứ tự này.',
    'Sử dụng dữ liệu này làm nguồn chính để kiểm tra.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

export interface ScreenPromptInput {
  readonly fileCount: number;
  readonly ocrTexts: ReadonlyMap<string, string>;
  readonly fileNames: readonly string[];
  readonly ruleSetVersion: string;
  readonly maxVisualRequests: number;
  /** Operator-supplied override. When present it REPLACES the rendered rules base. */
  readonly promptOverride?: string;
}

const SCREEN_OUTPUT_CONTRACT = [
  '=== OUTPUT ===',
  'Return ONLY valid JSON, no markdown fences:',
  '{',
  '  ' + Q + 'notes' + Q + ': ' + Q + 'what the text alone let you settle, and what it did not' + Q + ',',
  '  ' + Q + 'visual_requests' + Q + ': [',
  '    {',
  '      ' + Q + 'document_index' + Q + ': 0,',
  '      ' + Q + 'purpose' + Q + ': ' + Q + 'the exact question to answer by looking at this document' + Q + ',',
  '      ' + Q + 'rule_ids' + Q + ': [' + Q + 'PROC-3.2' + Q + ']',
  '    }',
  '  ]',
  '}',
  'Ask for a visual check ONLY when the OCR text cannot settle the rule it serves. Do not ask for a',
  'page you could already read. Every entry MUST cite a bracketed rule id from this base, and',
  'document_index must be the position of the document in the list above.',
].join('\n');

/**
 * Pass 1: screen the recovered text and name the visual checks the text cannot settle.
 *
 * No original is attached here on purpose. The whole point of the pass is to say what is
 * missing, so it must not be able to peek and quietly satisfy itself.
 */
export function buildScreenPrompt(input: ScreenPromptInput): string {
  const ruleSet = getRuleSet(input.ruleSetVersion);
  if (!ruleSet) {
    throw new Error('Unknown LC ruleset version ' + input.ruleSetVersion);
  }
  const header = [
    'You are a senior Documentary Credit (LC) checker performing the SCREENING pass of a two-pass examination.',
    input.fileCount + ' file(s) submitted for examination.',
    'No original document is attached to this call. Work from the OCR text alone.',
    'Your job is NOT to reach a verdict. Your job is to state which rules the text cannot settle, so',
    'that the second pass can open exactly those documents and look at them.',
  ].join('\n');
  const limit = [
    'You may request at most ' + input.maxVisualRequests + ' visual checks for this examination.',
    'Prefer few, specific questions over many vague ones. A check that asks for a whole document to be',
    'reviewed is not a check.',
  ].join('\n');
  if (input.promptOverride && input.promptOverride.trim().length > 0) {
    return [
      renderIdentity(ruleSet),
      header,
      limit,
      numberedOcrBlock(input.ocrTexts, input.fileNames),
      '',
      '=== OPERATOR OVERRIDE (replaces the rendered rules base) ===',
      input.promptOverride,
    ].join('\n');
  }
  return [header, limit, numberedOcrBlock(input.ocrTexts, input.fileNames), renderRulesetPrompt(ruleSet), SCREEN_OUTPUT_CONTRACT].join(
    '\n\n'
  );
}

const DIGEST_OUTPUT_CONTRACT = [
  '=== OUTPUT ===',
  'Return ONLY valid JSON, no markdown fences:',
  '{',
  '  ' + Q + 'document_index' + Q + ': 0,',
  '  ' + Q + 'observations' + Q + ': [',
  '    {',
  '      ' + Q + 'field' + Q + ': ' + Q + 'the specific thing looked at' + Q + ',',
  '      ' + Q + 'found' + Q + ': true,',
  '      ' + Q + 'evidence' + Q + ': ' + Q + 'what you actually see: the wording, the position, what is absent' + Q,
  '    }',
  '  ]',
  '}',
  'Report found=false when the thing is genuinely absent. When the page could not be read at all,',
  'describe what IS visible in evidence, so the adjudicator can tell not-present from not-readable.',
].join('\n');

export interface InspectionPromptInput {
  readonly fileName: string;
  readonly documentIndex: number;
  readonly purpose: string;
  readonly ruleIds: readonly string[];
  readonly ruleSetVersion: string;
}

/**
 * Pass 2: one document, one question, and only the rules that question serves.
 *
 * Rendering only the cited rules is what keeps the second pass affordable. An examiner who
 * needs to know whether a bill of lading is endorsed does not need the insurance paragraph.
 */
export function buildInspectionPrompt(input: InspectionPromptInput): string {
  const ruleSet = getRuleSet(input.ruleSetVersion);
  if (!ruleSet) {
    throw new Error('Unknown LC ruleset version ' + input.ruleSetVersion);
  }
  const cited = input.ruleIds.map((id) => {
    const rule = getRule(id);
    if (!rule) {
      throw new Error('Inspection cites rule ' + id + ' which is not in ruleset ' + input.ruleSetVersion);
    }
    return renderRule(rule);
  });
  return [
    'You are a senior Documentary Credit (LC) checker performing a VISUAL INSPECTION of one document.',
    renderIdentity(ruleSet),
    '=== THE QUESTION TO ANSWER ===',
    'document_index: ' + input.documentIndex,
    'document: ' + input.fileName,
    'question: ' + input.purpose,
    '',
    '=== RULES THIS QUESTION SERVES ===',
    cited.join('\n\n'),
    '',
    'Answer ONLY the question above. Do not examine anything else and do not reach a verdict.',
    DIGEST_OUTPUT_CONTRACT,
  ].join('\n');
}

export interface AdjudicationPromptInput {
  readonly fileCount: number;
  readonly ocrTexts: ReadonlyMap<string, string>;
  readonly fileNames: readonly string[];
  readonly visualDigests: readonly LcVisualDigest[];
  readonly screenNotes: string;
  readonly outstandingChecks: readonly LcVisualRequest[];
  readonly ruleSetVersion: string;
  /** Operator-supplied override. When present it REPLACES the rendered rules base. */
  readonly promptOverride?: string;
}

function renderDigests(digests: readonly LcVisualDigest[]): string {
  if (digests.length === 0) return '';
  const blocks = digests.map((digest) => {
    const observations = digest.observations
      .map((entry) => '  - ' + entry.field + ': ' + (entry.found ? 'PRESENT' : 'ABSENT') + ' — ' + entry.evidence)
      .join('\n');
    return [
      '--- VISUAL INSPECTION: ' + digest.fileName + ' (document_index ' + digest.documentIndex + ') ---',
      'question asked: ' + digest.purpose,
      'rules served: ' + digest.ruleIds.join(', '),
      observations,
    ].join('\n');
  });
  return [
    '',
    '=== VISUAL INSPECTION RESULTS (from the second pass) ===',
    'These are direct observations of the originals. Where a digest says ABSENT, treat it as a fact about',
    'the document. Where it says PRESENT, use the evidence rather than the OCR text for that field.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function renderOutstanding(requests: readonly LcVisualRequest[]): string {
  if (requests.length === 0) return '';
  return [
    '=== UNSATISFIED VISUAL CHECKS ===',
    'These questions were asked in the screening pass and could NOT be answered by inspection.',
    'Under MR-3 you may not assume an answer. Any rule they serve is unverified: flag it ADVISORY, or',
    'return PENDING if a MAJOR could be hiding in it. You may NOT return COMPLIANT.',
  ].join('\n');
}

/**
 * Pass 3: the adjudication. The only pass that may produce a verdict.
 *
 * It sees the whole text set, every digest that came back, the screening notes, and an
 * explicit list of the questions nobody answered. That last list is what stops a clean
 * verdict being produced over checks that were never performed.
 */
export function buildAdjudicationPrompt(input: AdjudicationPromptInput): string {
  const ruleSet = getRuleSet(input.ruleSetVersion);
  if (!ruleSet) {
    throw new Error('Unknown LC ruleset version ' + input.ruleSetVersion);
  }
  const preamble = [
    'You are a senior Documentary Credit (LC) checker performing the ADJUDICATION pass of a two-pass',
    'examination. The screening pass already ran over the OCR text and the inspection pass already',
    'opened the documents it asked about. You are the only pass that reaches a verdict.',
    'Screening notes: ' + (input.screenNotes.length > 0 ? input.screenNotes : '(none)'),
    'Document set: ' + input.fileCount + ' file(s). Visual inspections satisfied: ' + input.visualDigests.length + '.',
  ].join('\n');

  if (input.promptOverride && input.promptOverride.trim().length > 0) {
    return [
      renderIdentity(ruleSet),
      preamble,
      numberedOcrBlock(input.ocrTexts, input.fileNames),
      renderDigests(input.visualDigests),
      renderOutstanding(input.outstandingChecks),
      '',
      '=== OPERATOR OVERRIDE (replaces the rendered rules base) ===',
      input.promptOverride,
    ].join('\n');
  }
  return [
    preamble,
    numberedOcrBlock(input.ocrTexts, input.fileNames),
    renderDigests(input.visualDigests),
    renderOutstanding(input.outstandingChecks),
    renderRulesetPrompt(ruleSet),
  ].join('\n');
}

const VERDICT_LABELS: Readonly<Record<string, string>> = {
  COMPLIANT: 'HOP LE (COMPLIANT)',
  DISCREPANT: 'CO SAI LECH (DISCREPANT)',
  PENDING: 'CAN XEM XET (PENDING)',
};

const RECOMMENDATION_LABELS: Readonly<Record<string, string>> = {
  ACCEPT: 'DE XUAT CHAP NHAN THANH TOAN',
  REJECT: 'DE XUAT TU CHOI THANH TOAN',
  RESERVE_FOR_REVIEW: 'DE XUAT DE DUYET - XEM XET THEM',
};

export interface ReportPromptInput {
  readonly compliance: LcComplianceResult;
  readonly fileCount: number;
  readonly promptOverride?: string;
}

function countSeverity(compliance: LcComplianceResult, severity: 'MAJOR' | 'MINOR' | 'ADVISORY'): number {
  return compliance.discrepancies.filter((entry) => entry.severity === severity).length;
}

function discrepancyTable(compliance: LcComplianceResult): string {
  if (compliance.discrepancies.length === 0) return '*(No discrepancies found)*';
  return compliance.discrepancies
    .map((entry) =>
      '| ' +
      [entry.id, entry.severity, entry.document, entry.field, entry.issue, entry.ruleId].join(' | ') +
      ' |'
    )
    .join('\n');
}

function headerBlock(input: ReportPromptInput): string {
  const compliance = input.compliance;
  const missingLine =
    compliance.documentsMissing.length > 0
      ? 'Documents not presented: ' + compliance.documentsMissing.join(', ')
      : 'All expected documents accounted for.';
  return [
    'You are a senior Trade Finance Officer. Produce a professional LC CHECKING REPORT in Vietnamese.',
    '=== INPUT DATA ===',
    'Document set: ' + input.fileCount + ' file(s)',
    'Documents present: ' + compliance.documentsPresent.join(', '),
    missingLine,
    'Examination ruleset: ' + compliance.ruleSetVersion,
    'Examination result: ' + (VERDICT_LABELS[compliance.verdict] ?? compliance.verdict),
    'Recommendation: ' + (RECOMMENDATION_LABELS[compliance.recommendation] ?? compliance.recommendation),
    'Discrepancy count: ' +
      compliance.totalDiscrepancies +
      ' total (MAJOR: ' +
      countSeverity(compliance, 'MAJOR') +
      ', MINOR: ' +
      countSeverity(compliance, 'MINOR') +
      ', ADVISORY: ' +
      countSeverity(compliance, 'ADVISORY') +
      ')',
    'Examination summary: ' + compliance.summary,
    'Discrepancy table:',
    '| ID | Severity | Document | Field | Issue | Rule |',
    '|----|----------|----------|-------|-------|------|',
    discrepancyTable(compliance),
  ].join('\n');
}

const REPORT_STRUCTURE_LINES: readonly string[] = [
  '=== REPORT STRUCTURE ===',
  'Write a complete, formal LC Checking Report in Vietnamese using EXACTLY these sections:',
  '## I. THONG TIN BO CHUNG TU',
  'List each document received: type, reference number, date, issuing party. Note any documents not presented.',
  '## II. DANH SACH CHUNG TU',
  'Review the attached files and list their identifiers clearly.',
  '## III. KET QUA KIEM TRA TUAN THU',
  'State the overall verdict clearly. Full discrepancy table with UCP 600 and ISBP 821 references, grouped MAJOR first, then MINOR, then ADVISORY. For each MAJOR explain why it triggers Art. 16 refusal.',
  '## IV. NHAN XET VA DE XUAT XU LY',
  'Professional assessment from an examiner perspective. If COMPLIANT recommend acceptance and note any advisory items. If DISCREPANT, for each MAJOR state whether it is correctable by requesting an amendment or non-correctable, recommending rejection or waiver. If RESERVE_FOR_REVIEW list the items requiring senior approval.',
  '## V. KET LUAN',
  'One unambiguous final recommendation in formal banking language, plus an examiner signature line placeholder.',
  'FORMATTING:',
  '- Language: Vietnamese, professional banking register',
  '- Audience: Trade Finance Operations Head, Compliance Officer',
  '- Cite UCP 600 articles and ISBP 821 paragraphs explicitly',
  '- Maximum 2,000 words',
  '- Output in Markdown',
];

/** Step 4: render the checking report from an already-validated compliance result. */
export function buildReportPrompt(input: ReportPromptInput): string {
  if (input.promptOverride && input.promptOverride.trim().length > 0) {
    return [headerBlock(input), '', input.promptOverride].join('\n');
  }
  return [headerBlock(input), '', ...REPORT_STRUCTURE_LINES].join('\n');
}
