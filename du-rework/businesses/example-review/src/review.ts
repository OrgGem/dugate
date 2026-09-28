import { createHash } from 'node:crypto';
import type { TaskHandler, TaskContext, TaskDisposition } from '@du/worker-sdk';
import { LeaseLostError } from '@du/worker-sdk';
import { defaultParserFactory, DocumentFormatDetector } from '@du/document-kit';
import type { FormatDetectionResult, ParseResult } from '@du/document-kit';
import type {
  ReviewInput,
  ChildReviewInput,
  ItemReviewResult,
  ApprovalDecision,
  AggregateReviewOutput,
  ReviewArtifactRef,
} from './types';

const REVIEW_EVIDENCE_VERSION = 3;
const OFFICE_PARSER_MAX_BUFFER_SIZE_BYTES = 10 * 1024 * 1024;
const OFFICE_PARSER_TIMEOUT_MS = 30_000;
const OFFICE_PARSE_FAILURE_NOTE =
  'Unable to parse Office source artifact; review cannot continue without valid document evidence.';
const REASONING_FAILURE_NOTE = 'Reasoning invocation failed; provider details withheld.';
const REASONING_UNRESOLVED_NOTE = 'Reasoning response could not be resolved.';
const REASONING_COMPLETED_NOTE = 'Reasoning completed.';
const REASONING_COMPLIANCE_NOTE = 'Reasoning reported a compliance concern.';

type SafeReviewErrorCode =
  | 'DOCUMENT_PARSE_FAILED'
  | 'REASONING_PROVIDER_FAILED'
  | 'REASONING_INVOCATION_FAILED'
  | 'REASONING_INVOCATION_UNKNOWN'
  | 'REVIEW_RESUME_FAILED';

function logRedactedReviewError(errorCode: SafeReviewErrorCode): void {
  console.error('[example-review] review operation failed', {
    errorCode,
    details: '[REDACTED]',
  });
}

/**
 * Validates and parses raw operation input for the review action.
 * Enforces strict schemas for 1..10 artifact inputs per P7-01 BRD.
 * Rejects caller-supplied internal continuation state (childReviews) to prevent bypassing review.
 */
export function parseReviewInput(rawInput: Record<string, unknown>): ReviewInput {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    throw new Error('Input must be a non-null object');
  }

  // Reject caller-supplied continuation state or unexpected properties
  const allowedKeys = new Set([
    'reviewId',
    'artifacts',
    'checks',
    'requireApproval',
    'enableReasoning',
  ]);
  for (const key of Object.keys(rawInput)) {
    if (key === 'childReviews') {
      throw new Error('childReviews cannot be supplied by client; document review cannot be bypassed');
    }
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected input property: ${key}`);
    }
  }

  const reviewId = rawInput['reviewId'];
  if (typeof reviewId !== 'string' || reviewId.trim().length === 0 || reviewId.length > 128) {
    throw new Error('reviewId must be a non-empty string of at most 128 characters');
  }

  const rawArtifacts = rawInput['artifacts'];
  if (!Array.isArray(rawArtifacts)) {
    throw new Error('artifacts must be an array');
  }
  if (rawArtifacts.length < 1 || rawArtifacts.length > 10) {
    throw new Error(`artifacts array must contain between 1 and 10 items (received ${rawArtifacts.length})`);
  }

  const artifacts: ReviewArtifactRef[] = rawArtifacts.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`artifact at index ${index} must be an object`);
    }
    const rec = item as Record<string, unknown>;
    const artifactId = rec['artifactId'];
    if (typeof artifactId !== 'string' || artifactId.trim().length === 0) {
      throw new Error(`artifact at index ${index} must have a non-empty string artifactId`);
    }
    const fileName = rec['fileName'];
    if (fileName !== undefined && (typeof fileName !== 'string' || fileName.trim().length === 0)) {
      throw new Error(`artifact at index ${index} fileName must be a non-empty string if provided`);
    }
    return {
      artifactId,
      fileName: typeof fileName === 'string' ? fileName : undefined,
    };
  });

  let checks: Record<string, boolean> | undefined;
  const rawChecks = rawInput['checks'];
  if (rawChecks !== undefined) {
    if (typeof rawChecks !== 'object' || rawChecks === null || Array.isArray(rawChecks)) {
      throw new Error('checks must be an object of boolean values if provided');
    }
    const entries = Object.entries(rawChecks);
    if (entries.some(([name, val]) => name.trim().length === 0 || typeof val !== 'boolean')) {
      throw new Error('checks entries must have non-empty keys and boolean values');
    }
    checks = Object.fromEntries(entries) as Record<string, boolean>;
  }

  if (rawInput['requireApproval'] !== undefined && typeof rawInput['requireApproval'] !== 'boolean') {
    throw new Error('requireApproval must be a boolean if provided');
  }
  const requireApproval = rawInput['requireApproval'] === true;

  if (rawInput['enableReasoning'] !== undefined && typeof rawInput['enableReasoning'] !== 'boolean') {
    throw new Error('enableReasoning must be a boolean if provided');
  }
  const enableReasoning = rawInput['enableReasoning'] === true;

  return {
    reviewId,
    artifacts,
    checks,
    requireApproval,
    enableReasoning,
  };
}

/**
 * Validates and parses child task input for kind 'review-item'.
 */
export function parseChildReviewInput(rawInput: Record<string, unknown>): ChildReviewInput {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    throw new Error('Child review input must be an object');
  }

  // Reject unexpected child input properties
  const allowedKeys = new Set([
    'reviewId',
    'itemIndex',
    'artifact',
    'checks',
    'enableReasoning',
  ]);
  for (const key of Object.keys(rawInput)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected child input property: ${key}`);
    }
  }

  const reviewId = rawInput['reviewId'];
  if (typeof reviewId !== 'string' || reviewId.trim().length === 0 || reviewId.length > 128) {
    throw new Error('reviewId must be a non-empty string of at most 128 characters');
  }

  const rawItemIndex = rawInput['itemIndex'];
  if (
    typeof rawItemIndex !== 'number' ||
    !Number.isInteger(rawItemIndex) ||
    !Number.isFinite(rawItemIndex) ||
    rawItemIndex < 0 ||
    rawItemIndex > 9
  ) {
    throw new Error('itemIndex must be a non-negative integer between 0 and 9');
  }
  const itemIndex = rawItemIndex;

  const rawArt = rawInput['artifact'];
  if (typeof rawArt !== 'object' || rawArt === null || Array.isArray(rawArt)) {
    throw new Error('artifact must be a non-null object');
  }

  const artifactObj = rawArt as Record<string, unknown>;
  const allowedArtKeys = new Set(['artifactId', 'fileName']);
  for (const key of Object.keys(artifactObj)) {
    if (!allowedArtKeys.has(key)) {
      throw new Error(`Unexpected artifact property: ${key}`);
    }
  }

  const artifactId = artifactObj['artifactId'];
  if (typeof artifactId !== 'string' || artifactId.trim().length === 0) {
    throw new Error('artifact.artifactId must be a non-empty string');
  }

  const rawFileName = artifactObj['fileName'];
  if (rawFileName !== undefined && (typeof rawFileName !== 'string' || rawFileName.trim().length === 0)) {
    throw new Error('artifact.fileName must be a non-empty string if provided');
  }

  let checks: Record<string, boolean> | undefined;
  if (rawInput['checks'] !== undefined) {
    if (typeof rawInput['checks'] !== 'object' || rawInput['checks'] === null || Array.isArray(rawInput['checks'])) {
      throw new Error('checks must be an object of boolean values if provided');
    }
    const entries = Object.entries(rawInput['checks']);
    if (entries.some(([name, val]) => name.trim().length === 0 || typeof val !== 'boolean')) {
      throw new Error('checks entries must have non-empty keys and boolean values');
    }
    checks = Object.fromEntries(entries) as Record<string, boolean>;
  }

  if (rawInput['enableReasoning'] !== undefined && typeof rawInput['enableReasoning'] !== 'boolean') {
    throw new Error('enableReasoning must be a boolean if provided');
  }
  const enableReasoning = rawInput['enableReasoning'] === true;

  return {
    reviewId,
    itemIndex,
    artifact: {
      artifactId,
      fileName: typeof rawFileName === 'string' ? rawFileName : undefined,
    },
    checks,
    enableReasoning,
  };
}

/**
 * Validates and strictly parses approval decision from human wait response.
 * Rejects non-boolean approved fields (Boolean('false') must not approve) and extra properties.
 */
export function parseApprovalResponse(raw: unknown): ApprovalDecision {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Approval response must be a non-null object');
  }
  const rec = raw as Record<string, unknown>;

  const allowedKeys = new Set(['approved', 'note', 'approver', 'decidedAt']);
  for (const key of Object.keys(rec)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unexpected approval property: ${key}`);
    }
  }

  if (typeof rec['approved'] !== 'boolean') {
    throw new Error('approval.approved must be a boolean');
  }

  const note = rec['note'];
  if (note !== undefined && typeof note !== 'string') {
    throw new Error('approval.note must be a string if provided');
  }

  const approver = rec['approver'];
  if (approver !== undefined && typeof approver !== 'string') {
    throw new Error('approval.approver must be a string if provided');
  }

  const decidedAt = typeof rec['decidedAt'] === 'string' ? rec['decidedAt'] : undefined;

  return {
    approved: rec['approved'],
    note,
    approver,
    decidedAt,
  };
}

/**
 * Evaluates document content and checks for a single artifact deterministically.
 */
export function evaluateItemChecks(
  artifactContent: Buffer,
  checks?: Record<string, boolean>,
  reasoningNotes?: string,
  reasoningFailedCheck?: string
): { passed: boolean; failedChecks: string[] } {
  const failed: string[] = [];

  // Content sanity check
  if (artifactContent.length === 0) {
    failed.push('non-empty-content');
  }

  // Evaluate named checks
  if (checks) {
    for (const [name, pass] of Object.entries(checks)) {
      if (!pass) {
        failed.push(name);
      }
    }
  }

  // Evaluate reasoning outcome
  if (reasoningFailedCheck) {
    failed.push(reasoningFailedCheck);
  }

  // Sort failed checks alphabetically for byte-identical determinism
  failed.sort();

  return {
    passed: failed.length === 0,
    failedChecks: failed,
  };
}

function safeReasoningNote(reasoning: unknown, failedChecks: readonly string[]): string | undefined {
  if (typeof reasoning !== 'string') return undefined;
  if (failedChecks.includes('reasoning-compliance')) return REASONING_COMPLIANCE_NOTE;
  if (failedChecks.includes('reasoning-pending')) return 'Reasoning invocation pending without async settlement';
  if (failedChecks.includes('reasoning-invocation-unknown')) {
    return 'Provider invocation status unknown; blind retry prohibited';
  }
  if (failedChecks.includes('reasoning-failed') || failedChecks.includes('reasoning-error')) {
    return REASONING_FAILURE_NOTE;
  }
  if (failedChecks.includes('reasoning-unresolved')) return REASONING_UNRESOLVED_NOTE;
  return REASONING_COMPLETED_NOTE;
}

/**
 * Deterministically aggregates multiple item reviews and an optional approval decision.
 * The reviewsRef points to the separate persisted item reviews artifact.
 */
export function aggregateReviews(
  reviewId: string,
  items: ItemReviewResult[],
  reviewsRef: string,
  approval?: ApprovalDecision,
  version?: string
): AggregateReviewOutput {
  // Sort items deterministically by itemIndex ascending, then artifactId
  const safeItems = items.map((item) => ({
    ...item,
    reasoning: safeReasoningNote(item.reasoning, item.failedChecks),
  }));
  const sortedItems = [...safeItems].sort((a, b) => {
    if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
    return a.artifactId.localeCompare(b.artifactId);
  });

  // Deduplicate and sort all failed checks across all items
  const failedSet = new Set<string>();
  for (const item of sortedItems) {
    for (const fc of item.failedChecks) {
      failedSet.add(fc);
    }
  }
  const failedChecks = Array.from(failedSet).sort();

  const itemsApproved = sortedItems.length > 0 && sortedItems.every((item) => item.passed);
  const approved = approval !== undefined ? itemsApproved && approval.approved : itemsApproved;

  const verPrefix = version ? `[${version}] ` : '';
  const summary = approved
    ? `${verPrefix}Review ${reviewId} approved (${sortedItems.length} item(s) passed)`
    : `${verPrefix}Review ${reviewId} rejected (${failedChecks.length} failed check(s): ${failedChecks.join(', ')})`;

  return {
    reviewId,
    approved,
    itemCount: sortedItems.length,
    reviewsRef,
    failedChecks,
    items: sortedItems,
    approval,
    summary,
    version,
  };
}

function assertActive(ctx: TaskContext): void {
  if (ctx.signal?.aborted) {
    if (ctx.cancelRequested || ctx.signal.reason === 'cancel') {
      throw new Error('Task execution cancelled');
    }
    throw new LeaseLostError(ctx.taskId);
  }
}

async function readRequiredEvidence(
  ctx: TaskContext,
  artifactId: string,
  evidenceKind: string
): Promise<Buffer> {
  try {
    const content = await ctx.artifacts.read(artifactId);
    assertActive(ctx);
    return content;
  } catch (err: unknown) {
    if (err instanceof LeaseLostError || ctx.signal?.aborted) throw err;
    throw new Error(
      `Unable to read ${evidenceKind} artifact; review cannot continue without readable evidence.`
    );
  }
}

/**
 * Office evidence is always interpreted by document-kit's archive-guarded parser factory.
 * The factory performs archive preflight and runs its built-in parser in a terminable worker.
 * Non-Office evidence keeps the existing byte-oriented review behavior.
 */
async function prepareReviewEvidence(
  ctx: TaskContext,
  content: Buffer,
  fileName?: string
): Promise<Buffer> {
  const sourceName = (fileName ?? '').trim().split(/[?#]/, 1)[0] ?? '';
  const claimsOfficeByName = /\.(docx|xlsx)$/i.test(sourceName);
  let detection: FormatDetectionResult;
  try {
    detection = DocumentFormatDetector.detect(content, fileName);
  } catch {
    if (!claimsOfficeByName) return content;
    logRedactedReviewError('DOCUMENT_PARSE_FAILED');
    throw new Error(OFFICE_PARSE_FAILURE_NOTE);
  }

  const isDetectedOffice = detection.format === 'docx' || detection.format === 'xlsx';
  if (!claimsOfficeByName && !isDetectedOffice) return content;

  let parsed: ParseResult;
  try {
    parsed = await defaultParserFactory.parseBuffer(
      content,
      fileName,
      detection.mimeType,
      {
        maxBufferSizeBytes: OFFICE_PARSER_MAX_BUFFER_SIZE_BYTES,
        timeoutMs: OFFICE_PARSER_TIMEOUT_MS,
      }
    );
  } catch (err: unknown) {
    if (err instanceof LeaseLostError || ctx.signal?.aborted) throw err;
    logRedactedReviewError('DOCUMENT_PARSE_FAILED');
    throw new Error(OFFICE_PARSE_FAILURE_NOTE);
  }

  assertActive(ctx);
  if (
    (parsed.metadata.detectedFormat !== 'docx' && parsed.metadata.detectedFormat !== 'xlsx') ||
    (isDetectedOffice && parsed.metadata.detectedFormat !== detection.format) ||
    parsed.text.trim().length === 0
  ) {
    logRedactedReviewError('DOCUMENT_PARSE_FAILED');
    throw new Error(OFFICE_PARSE_FAILURE_NOTE);
  }

  return Buffer.from(parsed.text, 'utf8');
}

function parseJoinItemIndex(taskKey: string): number {
  const match = /^item-(\d+)$/.exec(taskKey);
  const itemIndex = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex > 9) {
    throw new Error(`Invalid child review task key in join summary: ${taskKey}`);
  }
  return itemIndex;
}

function parseJoinedItemResult(raw: unknown, reviewId: string, itemIndex: number): ItemReviewResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Child review result for item-${itemIndex} is not an object.`);
  }

  const result = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    'reviewId',
    'itemIndex',
    'artifactId',
    'fileName',
    'passed',
    'failedChecks',
    'reasoning',
    'itemArtifactRef',
    'reviewedAt',
  ]);
  if (Object.keys(result).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Child review result for item-${itemIndex} has unexpected properties.`);
  }

  const failedChecks = result['failedChecks'];
  if (
    result['reviewId'] !== reviewId ||
    result['itemIndex'] !== itemIndex ||
    typeof result['artifactId'] !== 'string' ||
    result['artifactId'].trim().length === 0 ||
    typeof result['passed'] !== 'boolean' ||
    !Array.isArray(failedChecks) ||
    failedChecks.some((check) => typeof check !== 'string') ||
    result['passed'] !== (failedChecks.length === 0) ||
    typeof result['reviewedAt'] !== 'string' ||
    result['reviewedAt'].trim().length === 0
  ) {
    throw new Error(`Child review result for item-${itemIndex} is incomplete or inconsistent.`);
  }

  if (
    (result['fileName'] !== undefined && typeof result['fileName'] !== 'string') ||
    (result['reasoning'] !== undefined && typeof result['reasoning'] !== 'string') ||
    (result['itemArtifactRef'] !== undefined && typeof result['itemArtifactRef'] !== 'string')
  ) {
    throw new Error(`Child review result for item-${itemIndex} has invalid optional fields.`);
  }

  return {
    reviewId,
    itemIndex,
    artifactId: result['artifactId'],
    fileName: result['fileName'] as string | undefined,
    passed: result['passed'],
    failedChecks: failedChecks as string[],
    reasoning: safeReasoningNote(result['reasoning'], failedChecks as string[]),
    itemArtifactRef: result['itemArtifactRef'] as string | undefined,
    reviewedAt: result['reviewedAt'],
  };
}

function parseJoinedItemJson(content: Buffer, taskKey: string): unknown {
  try {
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    throw new Error(`Child review result for ${taskKey} is not valid JSON.`);
  }
}

/**
 * Child task handler: reviews an individual document artifact.
 * Declared kind: 'review-item'.
 */
export const itemReviewHandler: TaskHandler = async (ctx: TaskContext): Promise<TaskDisposition> => {
  assertActive(ctx);
  const input = parseChildReviewInput(ctx.input);

  const sourceContent = await readRequiredEvidence(ctx, input.artifact.artifactId, 'source');
  const content = await prepareReviewEvidence(ctx, sourceContent, input.artifact.fileName);

  // Optional reasoning slot invocation if configured in profile/bindings
  let reasoningNotes: string | undefined;
  let reasoningFailedCheck: string | undefined;

  const reasoningConfigured = Boolean(
    (ctx.connectorBindings && ctx.connectorBindings['reasoning']) ||
    input.enableReasoning
  );

  if (reasoningConfigured) {
    const stepKey = `reasoning:${input.reviewId}:${input.itemIndex}`;
    const reasoningInputHash = createHash('sha256')
      .update(JSON.stringify({
        reviewId: input.reviewId,
        itemIndex: input.itemIndex,
        artifactId: input.artifact.artifactId,
      }))
      .digest('hex');

    const outcome = await ctx.step.run(
      stepKey,
      reasoningInputHash,
      async () => {
        assertActive(ctx);
        try {
          const response = await ctx.connector.invoke('reasoning', {
            prompt: `Review compliance for document: ${input.artifact.fileName ?? input.artifact.artifactId}`,
            text: content.toString('utf8').slice(0, 4000),
          });

          if (!response || response.state === 'FAILED') {
            logRedactedReviewError('REASONING_PROVIDER_FAILED');
            return {
              ok: false,
              failedCheck: 'reasoning-failed',
              notes: REASONING_FAILURE_NOTE,
            };
          }

          if (response.state === 'PENDING') {
            return {
              ok: false,
              failedCheck: 'reasoning-pending',
              notes: 'Reasoning invocation pending without async settlement',
            };
          }

          if (response.state === 'SUCCEEDED' && response.result) {
            const text =
              typeof response.result.content === 'string'
                ? response.result.content
                : JSON.stringify(response.result.data ?? {});
            if (text.includes('COMPLIANCE_FAILED') || text.includes('REJECTED')) {
              return {
                ok: false,
                failedCheck: 'reasoning-compliance',
                notes: REASONING_COMPLIANCE_NOTE,
              };
            }
            return {
              ok: true,
              notes: REASONING_COMPLETED_NOTE,
            };
          }

            return {
              ok: false,
              failedCheck: 'reasoning-unresolved',
              notes: REASONING_UNRESOLVED_NOTE,
          };
        } catch (err: unknown) {
          if (err instanceof LeaseLostError || ctx.signal?.aborted) {
            throw err;
          }
          const errCode = (err as { code?: string })?.code;
          if (errCode === 'INVOCATION_UNKNOWN') {
            logRedactedReviewError('REASONING_INVOCATION_UNKNOWN');
            return {
              ok: false,
              failedCheck: 'reasoning-invocation-unknown',
              notes: 'Provider invocation status unknown; blind retry prohibited',
            };
          }
          logRedactedReviewError('REASONING_INVOCATION_FAILED');
          return {
            ok: false,
            failedCheck: 'reasoning-error',
            notes: REASONING_FAILURE_NOTE,
          };
        }
      }
    );

    assertActive(ctx);
    reasoningNotes = outcome.notes;
    if (!outcome.ok && outcome.failedCheck) {
      reasoningFailedCheck = outcome.failedCheck;
    }
  }

  const evaluation = evaluateItemChecks(content, input.checks, reasoningNotes, reasoningFailedCheck);

  const timestamp = new Date().toISOString();
  const artifact = await ctx.artifacts.write(
    JSON.stringify({
      reviewId: input.reviewId,
      itemIndex: input.itemIndex,
      artifactId: input.artifact.artifactId,
      fileName: input.artifact.fileName,
      passed: evaluation.passed,
      failedChecks: evaluation.failedChecks,
      reasoning: reasoningNotes,
      reviewedAt: timestamp,
    }, null, 2),
    `${input.reviewId}-item-${input.itemIndex}.review.json`,
    'application/json',
    'intermediate'
  );

  assertActive(ctx);
  return {
    kind: 'completed',
    resultRef: `artifact://${artifact.artifactId}`,
  };
};

/**
 * Root review task handler: orchestrates review planning, bounded child spawn,
 * approval wait, and aggregate result output.
 * Declared kinds: 'review', 'root'.
 */
export const mainReviewHandler: TaskHandler = async (ctx: TaskContext): Promise<TaskDisposition> => {
  assertActive(ctx);

  // 0a. Check if this is a join continuation from child tasks (RUN-05)
  const rawJoinSummary = ctx.input?.['joinSummary'];
  if (rawJoinSummary !== undefined) {
    assertActive(ctx);
    if (typeof rawJoinSummary !== 'object' || rawJoinSummary === null || Array.isArray(rawJoinSummary)) {
      throw new Error('joinSummary must be an object containing every child review result.');
    }
    const joinSummary = rawJoinSummary as Record<string, unknown>;
    const joinEntries = Object.entries(joinSummary);
    if (joinEntries.length === 0) {
      throw new Error('joinSummary is empty; review cannot approve without child evidence.');
    }

    let reviewId = 'review';
    let requireApproval = false;
    const contRef = typeof ctx.input?.['continuationRef'] === 'string'
      ? ctx.input['continuationRef']
      : '';
    if (contRef.startsWith('join:')) {
      const parts = contRef.slice(5).split(':');
      reviewId = parts[0] || 'review';
      requireApproval = parts.includes('requireApproval') || parts.includes('approval');
    }

    const items: ItemReviewResult[] = [];
    for (const [taskKey, resultRef] of joinEntries) {
      assertActive(ctx);
      const itemIndex = parseJoinItemIndex(taskKey);
      if (typeof resultRef !== 'string') {
        throw new Error(`Child review result for ${taskKey} is missing; review cannot continue.`);
      }

      let rawItem: unknown;
      if (resultRef.startsWith('data:')) {
        const separator = resultRef.indexOf(',');
        if (separator < 0 || !resultRef.slice(0, separator).endsWith(';base64')) {
          throw new Error(`Child review result for ${taskKey} has an invalid data reference.`);
        }
        const decoded = Buffer.from(resultRef.slice(separator + 1), 'base64');
        rawItem = parseJoinedItemJson(decoded, taskKey);
      } else if (resultRef.startsWith('artifact://')) {
        const artifactId = resultRef.slice('artifact://'.length);
        if (!artifactId) {
          throw new Error(`Child review result for ${taskKey} has an empty artifact reference.`);
        }
        const content = await readRequiredEvidence(ctx, artifactId, `child review result for ${taskKey}`);
        rawItem = parseJoinedItemJson(content, taskKey);
      } else {
        throw new Error(`Child review result for ${taskKey} has an unsupported reference.`);
      }

      items.push(parseJoinedItemResult(rawItem, reviewId, itemIndex));
    }

    if (items.length !== joinEntries.length) {
      throw new Error('Join summary is incomplete; review cannot approve without every child result.');
    }

    const sortedItems = [...items].sort((a, b) => {
      if (a.itemIndex !== b.itemIndex) return a.itemIndex - b.itemIndex;
      return a.artifactId.localeCompare(b.artifactId);
    });

    const itemsArtifact = await ctx.artifacts.write(
      JSON.stringify(sortedItems, null, 2),
      `${reviewId}-items.review.json`,
      'application/json',
      'intermediate'
    );
    const reviewsRef = `artifact://${itemsArtifact.artifactId}`;

    const itemsStepKey = `evaluate-items:${reviewId}`;
    const itemsInputHash = createHash('sha256')
      .update(JSON.stringify({ reviewId, count: sortedItems.length }))
      .digest('hex');

    const savedEvaluation = await ctx.step.run<{ evidenceVersion?: number }>(itemsStepKey, itemsInputHash, async () => {
      return { items: sortedItems, reviewsRef, evidenceVersion: REVIEW_EVIDENCE_VERSION };
    });
    if (savedEvaluation.evidenceVersion !== REVIEW_EVIDENCE_VERSION) {
      throw new Error('Saved review checkpoint uses an outdated evidence policy; review cannot continue.');
    }

    if (requireApproval) {
      return await ctx.wait.waitForInput(
        'approval-wait',
        {
          type: 'object',
          properties: {
            approved: { type: 'boolean' },
            note: { type: 'string' },
            approver: { type: 'string' },
          },
          required: ['approved'],
          additionalProperties: false,
        },
        { contextRef: reviewsRef }
      );
    }

    const aggregate = aggregateReviews(reviewId, sortedItems, reviewsRef, undefined, ctx.businessVersion);
    const outputArtifact = await ctx.artifacts.write(
      JSON.stringify(aggregate, null, 2),
      `${reviewId}.review.json`,
      'application/json',
      'output'
    );
    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${outputArtifact.artifactId}`,
    };
  }

  // 0b. Check if this is a human wait resumption delivered via Orchestrator outbox (RUN-06)
  if (ctx.input && (ctx.input as Record<string, unknown>)['resumeInput'] !== undefined) {
    try {
      assertActive(ctx);
      const resumeInput = (ctx.input as Record<string, unknown>)['resumeInput'];
      const approval = parseApprovalResponse(resumeInput);

      const cpList = (typeof ctx.checkpoints === 'function' ? ctx.checkpoints() : ((ctx as unknown as { checkpointList?: Array<{ stepKey: string; inputHash: string }> }).checkpointList)) ?? [];
      const itemsCp = cpList.find((c) => c.stepKey.startsWith('evaluate-items:'));
      if (!itemsCp) {
        throw new Error(`Resuming from human wait requires a preceding evaluate-items checkpoint. Found checkpoints: ${JSON.stringify(cpList.map(c => c.stepKey))}`);
      }

      const reviewId = itemsCp.stepKey.slice('evaluate-items:'.length);
      const stepRes = await ctx.step.run<unknown>(
        itemsCp.stepKey,
        itemsCp.inputHash,
        async () => {
          throw new Error('Unexpected checkpoint re-execution on human wait resumption');
        }
      ) as {
        items?: ItemReviewResult[];
        reviewsRef?: string;
        evidenceVersion?: number;
        output?: { items?: ItemReviewResult[]; reviewsRef?: string; evidenceVersion?: number };
      } | undefined;

      const evidenceVersion = stepRes?.evidenceVersion ?? stepRes?.output?.evidenceVersion;
      if (evidenceVersion !== REVIEW_EVIDENCE_VERSION) {
        throw new Error('Saved review checkpoint uses an outdated evidence policy; approval cannot continue.');
      }

      const items: ItemReviewResult[] = stepRes?.items ?? stepRes?.output?.items ?? [];
      const reviewsRef: string = stepRes?.reviewsRef ?? stepRes?.output?.reviewsRef ?? '';

      const aggregate = aggregateReviews(reviewId, items, reviewsRef, approval, ctx.businessVersion);
      const outputArtifact = await ctx.artifacts.write(
        JSON.stringify(aggregate, null, 2),
        `${reviewId}.review.json`,
        'application/json',
        'output'
      );
      assertActive(ctx);
      return {
        kind: 'completed',
        resultRef: `artifact://${outputArtifact.artifactId}`,
      };
    } catch (err) {
      logRedactedReviewError('REVIEW_RESUME_FAILED');
      throw err;
    }
  }

  const input = parseReviewInput(ctx.input);

  // 1. Multi-document fan-out (>1 artifact)
  // Multi-document review plans bounded child tasks for each artifact (RUN-05).
  // Authoritative child output join requires the typed continuation contract from platform lane (P2-06/P4-04).
  if (input.artifacts.length > 1) {
    const childSpecs = input.artifacts.map((art, idx) => ({
      taskKey: `item-${idx}`,
      kind: 'review-item',
      payload: {
        reviewId: input.reviewId,
        itemIndex: idx,
        artifact: art,
        checks: input.checks,
        enableReasoning: input.enableReasoning,
      },
    }));

    const contRef = input.requireApproval
      ? `join:${input.reviewId}:requireApproval`
      : `join:${input.reviewId}`;

    // Bounded child review plan/join (RUN-05)
    return await ctx.spawn.spawnAndWait(
      childSpecs,
      'all-success',
      contRef
    );
  }

  // 2. Evaluate items under a durable step checkpoint
  // Ensures byte-identical replay across restarts and preserves review context across human wait
  const itemsStepKey = `evaluate-items:${input.reviewId}`;
  const itemsInputHash = createHash('sha256')
    .update(JSON.stringify({
      reviewId: input.reviewId,
      artifacts: input.artifacts,
      checks: input.checks,
      enableReasoning: input.enableReasoning,
    }))
    .digest('hex');

  const savedEvaluation = await ctx.step.run(
    itemsStepKey,
    itemsInputHash,
    async () => {
      assertActive(ctx);
      const art = input.artifacts[0]!;
      const sourceContent = await readRequiredEvidence(ctx, art.artifactId, 'source');
      const content = await prepareReviewEvidence(ctx, sourceContent, art.fileName);

      let reasoningNotes: string | undefined;
      let reasoningFailedCheck: string | undefined;

      const reasoningConfigured = Boolean(
        (ctx.connectorBindings && ctx.connectorBindings['reasoning']) ||
        input.enableReasoning
      );

      if (reasoningConfigured) {
        assertActive(ctx);
        try {
          const response = await ctx.connector.invoke('reasoning', {
            prompt: `Review compliance for document: ${art.fileName ?? art.artifactId}`,
            text: content.toString('utf8').slice(0, 4000),
          });

          if (!response || response.state === 'FAILED') {
            logRedactedReviewError('REASONING_PROVIDER_FAILED');
            reasoningFailedCheck = 'reasoning-failed';
            reasoningNotes = REASONING_FAILURE_NOTE;
          } else if (response.state === 'PENDING') {
            reasoningFailedCheck = 'reasoning-pending';
            reasoningNotes = 'Reasoning invocation pending without async settlement';
          } else if (response.state === 'SUCCEEDED' && response.result) {
            const text =
              typeof response.result.content === 'string'
                ? response.result.content
                : JSON.stringify(response.result.data ?? {});
            if (text.includes('COMPLIANCE_FAILED') || text.includes('REJECTED')) {
              reasoningFailedCheck = 'reasoning-compliance';
              reasoningNotes = REASONING_COMPLIANCE_NOTE;
            } else {
              reasoningNotes = REASONING_COMPLETED_NOTE;
            }
          } else {
            reasoningFailedCheck = 'reasoning-unresolved';
            reasoningNotes = REASONING_UNRESOLVED_NOTE;
          }
        } catch (err: unknown) {
          if (err instanceof LeaseLostError || ctx.signal?.aborted) {
            throw err;
          }
          const errCode = (err as { code?: string })?.code;
          if (errCode === 'INVOCATION_UNKNOWN') {
            logRedactedReviewError('REASONING_INVOCATION_UNKNOWN');
            reasoningFailedCheck = 'reasoning-invocation-unknown';
            reasoningNotes = 'Provider invocation status unknown; blind retry prohibited';
          } else {
            logRedactedReviewError('REASONING_INVOCATION_FAILED');
            reasoningFailedCheck = 'reasoning-error';
            reasoningNotes = REASONING_FAILURE_NOTE;
          }
        }
      }

      const evaluation = evaluateItemChecks(content, input.checks, reasoningNotes, reasoningFailedCheck);
      const reviewedAt = new Date().toISOString();

      const evaluatedItems: ItemReviewResult[] = [
        {
          reviewId: input.reviewId,
          itemIndex: 0,
          artifactId: art.artifactId,
          fileName: art.fileName,
          passed: evaluation.passed,
          failedChecks: evaluation.failedChecks,
          reasoning: reasoningNotes,
          reviewedAt,
        },
      ];

      // Persist the separate item reviews artifact inside the checkpoint
      const itemsArtifact = await ctx.artifacts.write(
        JSON.stringify(evaluatedItems, null, 2),
        `${input.reviewId}-items.review.json`,
        'application/json',
        'intermediate'
      );

      return {
        items: evaluatedItems,
        reviewsRef: `artifact://${itemsArtifact.artifactId}`,
        evidenceVersion: REVIEW_EVIDENCE_VERSION,
      };
    }
  );
  if (savedEvaluation.evidenceVersion !== REVIEW_EVIDENCE_VERSION) {
    throw new Error('Saved review checkpoint uses an outdated evidence policy; review cannot continue.');
  }

  const { items, reviewsRef } = savedEvaluation;

  // 3. Human-in-the-loop approval wait (RUN-06)
  if (input.requireApproval && ctx.waitResponse === undefined) {
    return await ctx.wait.waitForInput(
      'approval-wait',
      {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
          note: { type: 'string' },
          approver: { type: 'string' },
        },
        required: ['approved'],
        additionalProperties: false,
      },
      {
        contextRef: reviewsRef,
      }
    );
  }

  // 4. Parse approval decision strictly if resuming from wait
  let approval: ApprovalDecision | undefined;
  if (ctx.waitResponse !== undefined) {
    approval = parseApprovalResponse(ctx.waitResponse);
  }

  // 5. Aggregate final output with reviewsRef already populated before serialization
  const aggregate = aggregateReviews(input.reviewId, items, reviewsRef, approval, ctx.businessVersion);

  const outputArtifact = await ctx.artifacts.write(
    JSON.stringify(aggregate, null, 2),
    `${input.reviewId}.review.json`,
    'application/json',
    'output'
  );

  assertActive(ctx);
  return {
    kind: 'completed',
    resultRef: `artifact://${outputArtifact.artifactId}`,
  };
};

/** Default handler export matching earlier entrypoint naming */
export const reviewHandler: TaskHandler = mainReviewHandler;
