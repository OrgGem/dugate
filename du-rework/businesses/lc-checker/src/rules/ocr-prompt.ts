/**
 * Step 1 prompt: OCR one LC document into structured Markdown.
 *
 * Kept out of prompt-builders.ts because it carries no rule text. It is an OCR
 * instruction, not a rule: nothing cites it as authority, so it is not in the registry
 * and a ruleset version bump does not need to touch it.
 */

const OCR_RULE_LINES: readonly string[] = [
  '1. VERBATIM FIDELITY: transcribe ALL text exactly as it appears. Do NOT paraphrase, summarise or alter any content.',
  '2. SMART PAGE FILTERING: skip pages that contain ONLY general terms and conditions, pre-printed regulatory boilerplate, blank or separator pages, or standard template instructions not filled in. For a skipped page insert: [PAGE X: Skipped - general terms/template]',
  '3. MUST KEEP: always transcribe pages containing filled-in data fields such as names, amounts, dates, addresses, account numbers; handwritten annotations, stamps or signatures, described as [SIGNATURE], [STAMP: text], [HANDWRITTEN: text]; on-board notations, endorsements, amendments; any clause with specific transaction details such as L/C number, vessel name, port names; tables with cargo, quantity or weight data.',
  '4. TABLE INTEGRITY: convert tabular data to Markdown tables matching the original rows and columns. Do NOT flatten tables into paragraphs.',
  '5. STRUCTURE PRESERVATION: use H1 and H2 for section headers; preserve field labels such as Consignee; mark checkbox fields with [x] and [ ]; preserve page boundaries with --- PAGE X ---',
  '6. SPECIAL CHARACTERS: transcribe the best reading. If truly illegible use [illegible].',
];

export function buildOcrPrompt(fileName: string, documentTypeHint?: string): string {
  const header = [
    'You are a high-precision Document OCR Engine specialised in trade finance documents.',
    'FILE: ' + JSON.stringify(fileName),
  ];
  if (documentTypeHint && documentTypeHint.trim().length > 0) {
    header.push('DOCUMENT TYPE HINT: ' + documentTypeHint);
  }
  return header
    .concat([
      'Convert this document into clean, structured Markdown text.',
      '=== CRITICAL RULES ===',
    ])
    .concat(OCR_RULE_LINES)
    .concat(['Output the full Markdown transcription now. Begin directly with the content.'])
    .join('\n');
}
