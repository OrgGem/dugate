/**
 * P9-03 chunk planning, structure extraction and evidence merge.
 *
 * Pure functions only: no clock, no provider, no database. Everything here is
 * unit-testable offline, which is the point — the parts that decide WHAT to
 * compare should never need the things that do the comparing.
 *
 * The legacy workflow sent both whole documents into a single provider call
 * (`lib/pipelines/workflows/doc-compare.ts`, step 1 and step 2 both pass the
 * full `doc1Text`/`doc2Text`). Past the provider's context limit that call
 * simply fails, so the large-document path did not exist. Chunking is the fix,
 * and a chunk plan has to be deterministic or a resume would compare different
 * spans than the run it is resuming.
 */

import { createHash } from 'node:crypto';

import type {
  ChunkBoundaryKind,
  ChunkEvidence,
  ComparisonEvidence,
  DocumentChunkRef,
  DocumentSection,
  DocumentSideInput,
  SectionVerdict,
  ReferenceClaim,
  StructureClaim,
  StructurePlan,
  StructureSection,
} from './types';

export const DOC_COMPARE_EVIDENCE_VERSION = 'doc-compare-evidence-v1' as const;

/** Absolute ceiling so a hostile input cannot ask for one-chunk-per-character. */
export const MAX_CHUNK_CHARS = 200_000;
export const MIN_CHUNK_CHARS = 200;

/** Section-heading shapes we recognise: markdown ATX and numbered legal clauses. */
const HEADING_PATTERNS: readonly RegExp[] = [
  /^#{1,6}\s+(.+)$/,            // markdown ATX
  /^(?:Điều|Article)\s+(\d+[a-zA-Z.]*)[.:]?\s*(.*)$/i, // numbered clause
  /^(\d+(?:\.\d+)*)[.)\s]+\s*(.+)$/,                 // 1. / 1.1. / 1.1) 
];

/** Stable id for a section. Deterministic, so a resume re-derives the same ids. */
export function sectionIdFor(side: DocumentSideInput['side'], ordinal: number, title: string): string {
  const digest = createHash('sha256').update(`${side}:${ordinal}:${title}`).digest('hex');
  return `${side}-s${ordinal}-${digest.slice(0, 8)}`;
}

export function bodyDigestOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function headingOf(line: string): { title: string; level: number } | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  for (let i = 0; i < HEADING_PATTERNS.length; i += 1) {
    const pattern = HEADING_PATTERNS[i]!;
    const match = pattern.exec(trimmed);
    if (!match) continue;
    if (i === 0) {
      return { title: (match[1] ?? '').trim(), level: (match[0].match(/^#+/) ?? [''])[0]!.length };
    }
    const title = `${match[1] ?? ''} ${match[2] ?? ''}`.trim();
    return { title: title === '' ? (match[1] ?? '').trim() : title, level: i === 1 ? 1 : 2 };
  }
  return null;
}

/**
 * Split into lines while keeping each line's absolute span in the source text.
 *
 * `text.split(/\r?\n/)` throws the positions away, and every later offset was
 * therefore computed against a body-only string while the chunk was sliced out
 * of the full text. Handling CRLF here (rather than assuming a 1-char separator)
 * is what makes the recorded spans exact on Windows-authored documents.
 */
function splitLinesWithOffsets(text: string): { line: string; start: number; end: number }[] {
  const lines: { line: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i !== text.length && text[i] !== '\n') continue;
    let end = i;
    if (end > start && text[end - 1] === '\r') end -= 1;
    lines.push({ line: text.slice(start, end), start, end });
    start = i + 1;
  }
  return lines;
}

/**
 * Split normalised text into sections. Text before the first heading becomes a
 * synthetic section 0 so no byte is ever dropped from the comparison.
 *
 * Each section also records the span it OCCUPIES in `side.text` — heading line,
 * body and the separator that follows it. The spans tile the text with no gap
 * and no overlap, which is what lets `planChunks` emit offsets that index the
 * real text rather than a body-only projection of it.
 */
export function extractSections(side: DocumentSideInput): readonly DocumentSection[] {
  const lines = splitLinesWithOffsets(side.text);
  const sections: DocumentSection[] = [];
  let ordinal = 0;
  let currentTitle = '(preamble)';
  let currentLevel = 0;
  let buffer: string[] = [];
  let spanStart = 0;

  const flush = (spanEnd: number): void => {
    const body = buffer.join('\n');
    sections.push({
      sectionId: sectionIdFor(side.side, ordinal, currentTitle),
      title: currentTitle,
      level: currentLevel,
      ordinal,
      body,
      textStart: spanStart,
      textEnd: spanEnd,
    });
    ordinal += 1;
    buffer = [];
    // The next section starts exactly where this one ended. Without this the
    // following section would keep the SAME textStart and overlap this span.
    spanStart = spanEnd;
  };

  for (const { line, start } of lines) {
    const heading = headingOf(line);
    if (heading) {
      // Only flush real content: a heading on the very first line would
      // otherwise emit an empty (preamble) section that then competes in
      // alignment against a genuine section. A heading that is skipped this
      // way leaves `spanStart` untouched on purpose, so its line stays inside
      // the following section's span instead of becoming an unread gap.
      if (buffer.length > 0 || sections.length > 0) flush(start);
      currentTitle = heading.title;
      currentLevel = heading.level;
      continue;
    }
    buffer.push(line);
  }
  flush(side.text.length);
  return sections;
}

/**
 * Plan bounded chunks for one side.
 *
 * Sections are packed in order until the next one would exceed the budget; then a
 * section chunk is emitted. A single section larger than the budget is emitted as
 * an emergency `size` chunk rather than being truncated — a comparison that
 * silently skipped half a clause would report 'unchanged' for text it never read.
 */
export function planChunks(
  side: DocumentSideInput,
  maxChunkChars: number,
): readonly DocumentChunkRef[] {
  const budget = clampChunkBudget(maxChunkChars);
  const chunks: DocumentChunkRef[] = [];
  let ordinal = 0;

  let startOffset = 0;
  let accumulated = 0;
  let titles: string[] = [];
  let sectionIds: string[] = [];

  const emit = (kind: ChunkBoundaryKind, endOffset: number): void => {
    chunks.push({
      chunkId: `${side.side}-c${ordinal}`,
      side: side.side,
      ordinal,
      boundaryKind: kind,
      sectionTitle: titles.length === 1 ? titles[0]! : null,
      startOffset,
      endOffset,
      charCount: Math.max(0, endOffset - startOffset),
    });
    ordinal += 1;
    startOffset = endOffset;
    accumulated = 0;
    titles = [];
    sectionIds = [];
  };

  for (const section of side.sections) {
    // Measured on the section's SPAN, not on `section.body`: the budget bounds
    // what is sent to the provider, and the span is what actually gets sent.
    const length = Math.max(0, section.textEnd - section.textStart);
    const wouldOverflow = accumulated > 0 && accumulated + length > budget;

    if (wouldOverflow) emit('section', section.textStart);

    if (accumulated === 0 && length > budget) {
      // One section too big for a chunk: split it on size, keep it whole overall.
      let cursor = section.textStart;
      const end = section.textEnd;
      while (cursor < end) {
        const sliceEnd = Math.min(end, cursor + budget);
        const piece: DocumentChunkRef = {
          chunkId: `${side.side}-c${ordinal}`,
          side: side.side,
          ordinal,
          boundaryKind: 'size',
          sectionTitle: section.title,
          startOffset: cursor,
          endOffset: sliceEnd,
          charCount: sliceEnd - cursor,
        };
        chunks.push(piece);
        ordinal += 1;
        cursor = sliceEnd;
      }
      // The oversized branch advances `offset` but used to leave `startOffset`
      // on the PREVIOUS chunk's end, so the next emit() began a chunk before
      // this section and overlapped it. Advancing both keeps the tiling exact.
      startOffset = end;
      accumulated = 0;
      titles = [];
      sectionIds = [];
      continue;
    }

    accumulated += length;
    titles.push(section.title);
    sectionIds.push(section.sectionId);
  }

  if (accumulated > 0) {
    emit('section', side.text.length);
  } else if (chunks.length === 0) {
    // An empty document still gets one chunk: a comparison with nothing to
    // read must not look identical to one that was never run.
    chunks.push({
      chunkId: `${side.side}-c0`,
      side: side.side,
      ordinal: 0,
      boundaryKind: 'size',
      sectionTitle: titles[0] ?? null,
      startOffset: 0,
      endOffset: side.text.length,
      charCount: side.text.length,
    });
  }

  void sectionIds;
  return chunks;
}

export function clampChunkBudget(requested: number): number {
  if (!Number.isSafeInteger(requested)) return MIN_CHUNK_CHARS;
  if (requested < MIN_CHUNK_CHARS) return MIN_CHUNK_CHARS;
  return Math.min(requested, MAX_CHUNK_CHARS);
}

/* ------------------------------------------------------------------ */
/* Structure comparison                                                */
/* ------------------------------------------------------------------ */

/** Normalised title used for matching. Strips numbering, case and punctuation. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks BEFORE collapsing punctuation: a decomposed accent
    // is not a letter, so collapsing first turns it into a space.
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Align sections across the two sides.
 *
 * Three passes, strongest first: exact title, then normalised title, then
 * position among the still-unmatched on the other side. There is no score —
 * only the match kind that produced the pairing, so a reviewer can see WHY two
 * sections were paired instead of trusting a number.
 */
export function alignSections(
  left: readonly DocumentSection[],
  right: readonly DocumentSection[],
): ReadonlyArray<{ left: DocumentSection | null; right: DocumentSection | null; matchKind: 'exact' | 'normalized' | 'positional' | 'unmatched' }> {
  const usedRight = new Set<string>();
  const pairs: Array<{
    left: DocumentSection | null;
    right: DocumentSection | null;
    matchKind: 'exact' | 'normalized' | 'positional' | 'unmatched';
  }> = [];

  const takeExact = (leftSection: DocumentSection): DocumentSection | undefined =>
    right.find((r) => r.title === leftSection.title && !usedRight.has(r.sectionId));

  const takeNormalized = (leftSection: DocumentSection): DocumentSection | undefined => {
    const key = normalizeTitle(leftSection.title);
    if (key === '') return undefined;
    return right.find((r) => normalizeTitle(r.title) === key && !usedRight.has(r.sectionId));
  };

  for (const leftSection of left) {
    const exact = takeExact(leftSection);
    if (exact) {
      usedRight.add(exact.sectionId);
      pairs.push({ left: leftSection, right: exact, matchKind: 'exact' });
      continue;
    }
    const normalized = takeNormalized(leftSection);
    if (normalized) {
      usedRight.add(normalized.sectionId);
      pairs.push({ left: leftSection, right: normalized, matchKind: 'normalized' });
      continue;
    }
    pairs.push({ left: leftSection, right: null, matchKind: 'unmatched' });
  }

  // Pass 3: positional pairing among what is left, in document order.
  //
  // ONLY when the two unmatched sets are the SAME SIZE. A 1:1 correspondence is
  // the one case where position is evidence that two differently-titled sections
  // are the same clause renamed. With unequal sets, pairing anyway would swallow a
  // real deletion or addition: a document whose Clause B was removed and Clause C
  // added has one unmatched section per side, and reporting it as one MODIFIED
  // section would hide both changes from a reviewer.
  const leftFree = pairs.filter((p) => p.right === null && p.left !== null);
  const rightFree = right.filter((r) => !usedRight.has(r.sectionId));
  const freeCount = leftFree.length === rightFree.length ? leftFree.length : 0;
  for (let i = 0; i < freeCount; i += 1) {
    const leftPair = leftFree[i]!;
    const rightSection = rightFree[i]!;
    usedRight.add(rightSection.sectionId);
    leftPair.right = rightSection;
    leftPair.matchKind = 'positional';
  }

  // Whatever is still unmatched on the right is genuinely new content.
  for (const rightSection of right) {
    if (!usedRight.has(rightSection.sectionId)) {
      pairs.push({ left: null, right: rightSection, matchKind: 'unmatched' });
    }
  }

  return pairs;
}

/**
 * Build one section claim from an aligned pair.
 *
 * `moved` is decided from ordinals only when both sides are present AND the match
 * was not exact-by-position; a pure position shift is reported rather than scored.
 */
export function buildStructureClaim(input: {
  pair: { left: DocumentSection | null; right: DocumentSection | null; matchKind: string };
  chunkIds: readonly string[];
}): StructureClaim {
  const { pair, chunkIds } = input;
  const { left, right } = pair;
  let verdict: SectionVerdict;
  let detail: string;

  if (left === null && right !== null) {
    verdict = 'added';
    detail = `Section present only on the right: "${right.title}"`;
  } else if (right === null && left !== null) {
    verdict = 'removed';
    detail = `Section present only on the left: "${left.title}"`;
  } else if (left === null || right === null) {
    // Unreachable after the two branches above, but narrowing here keeps the
    // digest comparisons below free of null checks and without an assertion.
    verdict = 'unchanged';
    detail = 'Empty alignment slot';
  } else if (bodyDigestOf(left.body) === bodyDigestOf(right.body)) {
    verdict = 'unchanged';
    detail = 'Body digests are identical';
  } else if (left.ordinal !== right.ordinal) {
    verdict = 'moved';
    detail = `Body changed and the section moved: ordinal ${left.ordinal} -> ${right.ordinal}`;
  } else {
    verdict = 'modified';
    detail = 'Body digests differ at the same ordinal';
  }

  return {
    claimId: `sc-${left?.sectionId ?? right?.sectionId ?? 'empty'}`,
    verdict,
    leftSectionId: left?.sectionId ?? null,
    rightSectionId: right?.sectionId ?? null,
    leftTitle: left?.title ?? null,
    rightTitle: right?.title ?? null,
    detail,
    evidenceChunkIds: chunkIds,
  };
}

/* ------------------------------------------------------------------ */
/* Structure plan + merge                                              */
/* ------------------------------------------------------------------ */

export function buildStructurePlan(input: {
  left: DocumentSideInput;
  right: DocumentSideInput;
  maxChunkChars: number;
}): StructurePlan {
  const toStructure = (side: DocumentSideInput): readonly StructureSection[] =>
    side.sections.map((section) => ({
      sectionId: section.sectionId,
      title: section.title,
      level: section.level,
      ordinal: section.ordinal,
      side: side.side,
      bodyDigest: bodyDigestOf(section.body),
    }));

  return {
    left: toStructure(input.left),
    right: toStructure(input.right),
    chunks: [
      ...planChunks(input.left, input.maxChunkChars),
      ...planChunks(input.right, input.maxChunkChars),
    ],
  };
}

/**
 * Merge per-chunk evidence into ONE record.
 *
 * Chunks that produced nothing because their child failed are listed in
 * `incompleteChunks` rather than being dropped: a reviewer must be able to see
 * that the evidence set is partial instead of reading a clean total.
 */
export function mergeChunkEvidence(input: {
  leftFileName: string;
  rightFileName: string;
  chunks: readonly ChunkEvidence[];
  failedChunkIds: readonly string[];
}): ComparisonEvidence {
  const structureClaims: StructureClaim[] = [];
  const referenceClaims: ReferenceClaim[] = [];

  for (const chunk of [...input.chunks].sort((a, b) => a.ordinal - b.ordinal || a.chunkId.localeCompare(b.chunkId))) {
    structureClaims.push(...chunk.structureClaims);
    referenceClaims.push(...chunk.referenceClaims);
  }

  const counts: Record<SectionVerdict, number> = {
    unchanged: 0, modified: 0, added: 0, removed: 0, moved: 0,
  };
  for (const claim of structureClaims) counts[claim.verdict] += 1;

  return {
    evidenceVersion: DOC_COMPARE_EVIDENCE_VERSION,
    leftFileName: input.leftFileName,
    rightFileName: input.rightFileName,
    chunkCount: input.chunks.length,
    structureClaims,
    referenceClaims,
    verdictCounts: counts,
    incompleteChunks: [...input.failedChunkIds].sort(),
  };
}
