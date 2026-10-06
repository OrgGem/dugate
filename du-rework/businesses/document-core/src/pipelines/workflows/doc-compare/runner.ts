/**
 * D4 - production chunk runner for doc-compare.
 *
 * P9-03 delivered the state machine and its continuation vocabulary, but every
 * test ran on a stub runtime: nothing implemented `runChunk`, so the module could
 * not actually run. This file is that implementation.
 *
 * ## Fail-closed, in both directions
 *
 * `status: 'succeeded'` is only ever returned when the connector said SUCCESS
 * AND the reply validated into the shape the stage expects. A connector error, an
 * unparseable reply, a missing required field, an empty claim list, or an identity
 * field in the reply all produce `status: 'failed'` with a module error code.
 *
 * The legacy workflow showed the failure this avoids: `parseDeep` on whatever the
 * provider returned, cast to `DocCompareResult` with no validation at all
 * (`lib/pipelines/workflows/doc-compare.ts`, steps 1 and 2).
 */

import type { ConnectorInvocationOptions, ConnectorInvocationResult } from '../../../types/context';
import { STEP_KEYS } from '../../../recipes/step-keys';
import { normalizeTitle } from './chunking';
import {
  DOC_COMPARE_INPUT_VERSION,
  type ChunkEvidence,
  type DocumentChunkRef,
  type DocumentSideInput,
  type ReferenceClaim,
  type ReferenceVerdict,
  type SectionVerdict,
  type StructureClaim,
  type StructurePlan,
} from './types';
import type { ChunkOutcome, ChunkTaskSpec } from './primitives';
import type { DocCompareRuntime } from './doc-compare';

export interface DocCompareConnectorPort {
  invoke(
    slot: 'ocr' | 'reasoning' | 'vision',
    promptOrPayload: string | Record<string, unknown>,
    options?: ConnectorInvocationOptions,
  ): Promise<ConnectorInvocationResult>;
}

export interface DocCompareConnectorBinding {
  readonly slot: 'ocr' | 'reasoning' | 'vision';
  /** Provider task discriminator per stage. Module config, never a hard-coded prompt. */
  readonly structureTask: string;
  readonly referenceTask: string;
}

export const DEFAULT_DOC_COMPARE_BINDING: DocCompareConnectorBinding = {
  slot: 'reasoning',
  structureTask: 'doc_compare_structure',
  referenceTask: 'doc_compare_references',
};

export interface DocCompareRunnerOptions {
  readonly connector: DocCompareConnectorPort;
  readonly binding?: DocCompareConnectorBinding;
  /** Per-call options. `responseFormat` is forced to json by the runner. */
  readonly invocationOptions?: Omit<ConnectorInvocationOptions, 'responseFormat'>;
  readonly timeoutMs?: number;
  readonly checkpointKeyFor?: (stepId: string) => string;
  readonly checkpointsEnabled?: boolean;
}

export const DEFAULT_DOC_COMPARE_CHUNK_TIMEOUT_MS = 120_000;

/**
 * Error codes are CHUNK-scoped, not provider-scoped: the merge records a chunk id
 * and a reason and must not have to know which provider failed. The provider's own
 * code is preserved inside `message` so an operator can still trace it.
 */
export type DocCompareChunkErrorCode =
  | 'CHUNK_FAILED'
  | 'CHUNK_TIMEOUT'
  | 'CHUNK_INVALID_INPUT'
  | 'CHUNK_MALFORMED_RESPONSE'
  | 'CHUNK_EMPTY_EVIDENCE'
  | 'CHUNK_IDENTITY_LEAK';

export class DocCompareChunkError extends Error {
  constructor(readonly code: DocCompareChunkErrorCode, message: string) {
    super(message);
    this.name = 'DocCompareChunkError';
  }
}

/**
 * Keys are stored ALREADY NORMALIZED (no case, no dashes or underscores), and a
 * candidate key is normalized the same way before the lookup. Comparing raw keys
 * against a raw list is how this guard silently stopped matching: apiKeyId and
 * api_key_id are the same field and neither raw string equals the other.
 */
const FORBIDDEN_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'apikey',
  'apikeyid',
  'xapikey',
  'xapikeyid',
  'tenantid',
  'userid',
  'createdbyuserid',
  'authorization',
  'role',
]);

/**
 * Refuse a payload or a reply that carries an identity field.
 *
 * The reply side matters as much as the request side: a provider that echoes a
 * tenant or key back into the comparison is either leaking it into evidence or
 * letting a client choose identity through the reply, and neither may reach a
 * reviewer as a comparison result.
 */
export function assertNoIdentityLeak(value: unknown, where: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoIdentityLeak(item, where);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-_]+/g, '').toLowerCase();
    if (FORBIDDEN_IDENTITY_KEYS.has(normalized)) {
      throw new DocCompareChunkError(
        'CHUNK_IDENTITY_LEAK',
        `identity field '${key}' is not accepted in ${where}`,
      );
    }
    assertNoIdentityLeak(child, where);
  }
}

export interface DocCompareChunkInput {
  readonly chunk: DocumentChunkRef;
  readonly left: DocumentSideInput;
  readonly right: DocumentSideInput;
  readonly structure: StructurePlan | null;
}

function isChunkInput(value: unknown): value is DocCompareChunkInput {
  if (typeof value !== 'object' || value === null) return false;
  const chunk = (value as Record<string, unknown>).chunk;
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    typeof (chunk as Record<string, unknown>).chunkId === 'string'
  );
}

/**
 * Slice the chunk's text out of its side.
 *
 * This is the bound that makes the runner real: the spec carries the WHOLE
 * document because the state machine needs both sides for alignment, but the
 * payload carries only `endOffset - startOffset` characters. Offsets are clamped
 * so a corrupt plan degrades to the available text instead of throwing mid-fan-out.
 *
 * The offsets index `side.text` itself. `planChunks` used to build them by
 * summing `section.body.length`, which excludes heading lines, so every slice
 * was shifted by the headings before it and the tail of the document was never
 * read. `planChunks` now emits text-space offsets that tile the text exactly.
 */
export function sliceChunkText(side: DocumentSideInput, chunk: DocumentChunkRef): string {
  const start = Math.max(0, Math.min(chunk.startOffset, side.text.length));
  const end = Math.max(start, Math.min(chunk.endOffset, side.text.length));
  return side.text.slice(start, end);
}

function sectionsInChunk(side: DocumentSideInput, chunk: DocumentChunkRef): ReadonlyArray<{
  sectionId: string;
  title: string;
  body: string;
}> {
  return side.sections
    .filter((section) => chunk.sectionTitle === null || section.title === chunk.sectionTitle)
    .map((section) => ({
      sectionId: section.sectionId,
      title: section.title,
      body: section.body.slice(0, Math.max(0, chunk.charCount)),
    }));
}

/** Section titles of the OTHER side that this chunk's document does not have. */
function counterpartTitles(input: DocCompareChunkInput): ReadonlyArray<{
  title: string;
  sectionId: string;
}> {
  const own = input.chunk.side === 'left' ? input.left : input.right;
  const other = input.chunk.side === 'left' ? input.right : input.left;
  const ownTitles = new Set(own.sections.map((section) => normalizeTitle(section.title)));
  return other.sections
    .filter((section) => !ownTitles.has(normalizeTitle(section.title)))
    .map((section) => ({ title: section.title, sectionId: section.sectionId }));
}

function buildChunkPayload(input: DocCompareChunkInput): Record<string, unknown> {
  const own = input.chunk.side === 'left' ? input.left : input.right;
  const text = sliceChunkText(own, input.chunk);
  const plan = input.structure;
  const alignedSections = plan === null
    ? []
    : (input.chunk.side === 'left' ? plan.left : plan.right).map((section) => ({
        sectionId: section.sectionId,
        title: section.title,
        ordinal: section.ordinal,
      }));
  return {
    comparison: 'doc-compare-advanced',
    schemaVersion: DOC_COMPARE_INPUT_VERSION,
    side: input.chunk.side,
    chunkId: input.chunk.chunkId,
    ordinal: input.chunk.ordinal,
    boundaryKind: input.chunk.boundaryKind,
    fileName: own.fileName,
    artifactId: own.artifactId,
    sectionTitle: input.chunk.sectionTitle,
    chunkText: text,
    chunkCharCount: text.length,
    sections: sectionsInChunk(own, input.chunk),
    counterpartSectionTitles: counterpartTitles(input),
    alignedSections,
  };
}

const SECTION_VERDICTS: readonly string[] = ['unchanged', 'modified', 'added', 'removed', 'moved'];
const REFERENCE_VERDICTS: readonly string[] = ['resolved', 'unresolved', 'contradicted', 'not-applicable'];

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function claimList(value: unknown, field: string): unknown[] {
  const raw = Array.isArray(value) ? value : (value as { [key: string]: unknown } | null)?.[field];
  if (!Array.isArray(raw)) {
    throw new DocCompareChunkError(
      'CHUNK_MALFORMED_RESPONSE',
      `connector reply did not contain a ${field} array`,
    );
  }
  return raw;
}

/** Parse a structure reply. A claim without a chunk reference is not traceable. */
export function parseStructureClaims(value: unknown): StructureClaim[] {
  return claimList(value, 'structureClaims').map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new DocCompareChunkError(
        'CHUNK_MALFORMED_RESPONSE',
        `structureClaims[${index}] is not an object`,
      );
    }
    const record = entry as Record<string, unknown>;
    const verdict = str(record.verdict);
    if (verdict === null || !SECTION_VERDICTS.includes(verdict)) {
      throw new DocCompareChunkError(
        'CHUNK_MALFORMED_RESPONSE',
        `structureClaims[${index}].verdict must be one of ${SECTION_VERDICTS.join(', ')}`,
      );
    }
    const evidence = Array.isArray(record.evidenceChunkIds) ? record.evidenceChunkIds : [];
    return {
      claimId: str(record.claimId) ?? `sc-${index}`,
      verdict: verdict as SectionVerdict,
      leftSectionId: str(record.leftSectionId),
      rightSectionId: str(record.rightSectionId),
      leftTitle: str(record.leftTitle),
      rightTitle: str(record.rightTitle),
      detail: str(record.detail) ?? '',
      evidenceChunkIds: evidence.filter((id): id is string => typeof id === 'string'),
    };
  });
}

/** Parse a reference reply. */
export function parseReferenceClaims(value: unknown): ReferenceClaim[] {
  return claimList(value, 'referenceClaims').map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new DocCompareChunkError(
        'CHUNK_MALFORMED_RESPONSE',
        `referenceClaims[${index}] is not an object`,
      );
    }
    const record = entry as Record<string, unknown>;
    const verdict = str(record.verdict);
    if (verdict === null || !REFERENCE_VERDICTS.includes(verdict)) {
      throw new DocCompareChunkError(
        'CHUNK_MALFORMED_RESPONSE',
        `referenceClaims[${index}].verdict must be one of ${REFERENCE_VERDICTS.join(', ')}`,
      );
    }
    const evidence = Array.isArray(record.evidenceChunkIds) ? record.evidenceChunkIds : [];
    return {
      claimId: str(record.claimId) ?? `rc-${index}`,
      verdict: verdict as ReferenceVerdict,
      reference: str(record.reference) ?? '',
      sectionId: str(record.sectionId) ?? '',
      side: record.side === 'right' ? 'right' : 'left',
      target: str(record.target),
      detail: str(record.detail) ?? '',
      evidenceChunkIds: evidence.filter((id): id is string => typeof id === 'string'),
    };
  });
}

/**
 * Extract the parsed reply: prefer `data`, else strip a fenced block off
 * `rawText`. Unlike the compare action, an unparseable rawText is NOT wrapped
 * into a pseudo-result: it fails, because a pseudo-result would reach a reviewer
 * as a comparison finding.
 */
export function extractInvocationPayload(invocation: ConnectorInvocationResult): unknown {
  if (invocation.data !== undefined && invocation.data !== null) return invocation.data;
  const raw = invocation.rawText;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    throw new DocCompareChunkError(
      'CHUNK_MALFORMED_RESPONSE',
      'connector reply was neither structured data nor parseable JSON',
    );
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, chunkId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DocCompareChunkError('CHUNK_TIMEOUT', `chunk ${chunkId} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Build the production `DocCompareRuntime`.
 *
 * `runChunk` never throws for a business reason: every failure becomes a
 * `failed` outcome carrying a module code, because the fan-out treats a throw as
 * an unstructured crash while the merge needs a recordable reason.
 */
export function createDocCompareRuntime(options: DocCompareRunnerOptions): DocCompareRuntime {
  const binding = options.binding ?? DEFAULT_DOC_COMPARE_BINDING;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOC_COMPARE_CHUNK_TIMEOUT_MS;

  const runChunk = async (spec: ChunkTaskSpec): Promise<ChunkOutcome> => {
    const chunkId = spec.chunkId;
    try {
      if (!isChunkInput(spec.input)) {
        throw new DocCompareChunkError(
          'CHUNK_INVALID_INPUT',
          `chunk ${chunkId} was dispatched without a chunk descriptor`,
        );
      }
      assertNoIdentityLeak(spec.input, `the payload for chunk ${chunkId}`);

      const payload = buildChunkPayload(spec.input);
      const isStructure = spec.stage === 'compare-structure';

      const invocation = await withTimeout(
        options.connector.invoke(
          binding.slot,
          {
            task: isStructure ? binding.structureTask : binding.referenceTask,
            payload,
          },
          {
            ...(options.invocationOptions ?? {}),
            responseFormat: 'json',
            // CR06-01: the workflow stage key is authoritative — a caller's
            // invocationOptions must not be able to drop or replace it, or the
            // prompt-override wiring silently bypasses again.
            promptStepId: isStructure
              ? STEP_KEYS.DOC_COMPARE.COMPARE_STRUCTURE
              : STEP_KEYS.DOC_COMPARE.COMPARE_REFERENCES,
          },
        ),
        timeoutMs,
        chunkId,
      );

      if (invocation.status !== 'SUCCESS') {
        throw new DocCompareChunkError(
          'CHUNK_FAILED',
          `connector reported ${invocation.error?.code ?? 'ERROR'}: ${invocation.error?.message ?? 'no detail'}`,
        );
      }

      const reply = extractInvocationPayload(invocation);
      assertNoIdentityLeak(reply, `the reply for chunk ${chunkId}`);

      const structureClaims = isStructure ? parseStructureClaims(reply) : [];
      const referenceClaims = isStructure ? [] : parseReferenceClaims(reply);

      if (structureClaims.length === 0 && referenceClaims.length === 0) {
        throw new DocCompareChunkError(
          'CHUNK_EMPTY_EVIDENCE',
          `chunk ${chunkId} produced no claims; nothing was compared`,
        );
      }

      const evidence: ChunkEvidence = {
        chunkId,
        side: spec.input.chunk.side,
        ordinal: spec.input.chunk.ordinal,
        charCount: spec.input.chunk.charCount,
        sectionIds: spec.input.chunk.sectionTitle === null ? [] : [spec.input.chunk.sectionTitle],
        structureClaims,
        referenceClaims,
      };
      return { chunkId, status: 'succeeded', evidence };
    } catch (error: unknown) {
      const code = error instanceof DocCompareChunkError ? error.code : 'CHUNK_FAILED';
      const message =
        error instanceof Error ? error.message : 'chunk failed with a non-Error value';
      return { chunkId, status: 'failed', error: { code, message } };
    }
  };

  return {
    runChunk,
    ...(options.checkpointKeyFor === undefined ? {} : { checkpointKeyFor: options.checkpointKeyFor }),
    ...(options.checkpointsEnabled === undefined ? {} : { checkpointsEnabled: options.checkpointsEnabled }),
  };
}
