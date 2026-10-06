/**
 * P9-01 disbursement — bounded multi-step business workflow.
 *
 * Stages (dependency order; the orchestrator checkpoints each one):
 *   1. classify   — bounded fan-out, one child per file
 *   2. extract    — bounded fan-out, one child per file, scoped to its logical docs
 *   3. approval   — wait for a human; corrections arrive in the resume payload
 *   4. crosscheck — sequential, against business-supplied reference data
 *   5. report     — sequential
 *
 * Deliberate differences from the legacy implementation, all itemised in the report:
 *   - Bounded fan-out instead of an unbounded Promise.all (P9-01 deliverable).
 *   - No client-supplied identity. The legacy read `apiKeyId` from a form field and fell
 *     back to the oldest ADMIN key; here identity is not in the input type at all and the
 *     guard actively rejects it.
 *   - Terminal states are SUCCEEDED and FAILED only. This module never DECLARES a
 *     cancellation; an aborted run surfaces as a thrown error and the platform owns it.
 *   - Evidence must be sealed before approval when the deployment requires it.
 */

import {
  MAX_FANOUT_CONCURRENCY,
  type ChildTaskSpec,
  type DisbursementContinuation,
  type JoinSubmission,
} from './primitives';
import { resolveConcurrency, runBoundedFanout, type FanoutOutcome } from './fanout';
import { StepCheckpointManager } from '../../step-checkpoint';
import {
  DISBURSEMENT_INPUT_VERSION,
  DISBURSEMENT_RESUME_VERSION,
  DISBURSEMENT_RESULT_VERSION,
  emptyDisbursementState,
  type ApprovalEvidence,
  type CrosscheckResult,
  type DisbursementInput,
  type DisbursementPorts,
  type DisbursementResumeInput,
  type DisbursementState,
  type ExtractedRecord,
  type FileClassification,
  type LogicalDocument,
} from './types';

export const DISBURSEMENT_BUSINESS_ID = 'document-core' as const;
export const DISBURSEMENT_BUSINESS_VERSION = '1.0.0' as const;

/** Stable step ids: they must not change across resumes or checkpoints are orphaned. */
export const DISBURSEMENT_STEP_IDS = {
  classify: 'disbursement:classify:v1',
  extract: 'disbursement:extract:v1',
  crosscheck: 'disbursement:crosscheck:v1',
  report: 'disbursement:report:v1',
} as const;

export type DisbursementErrorCode =
  | 'INPUT_INVALID'
  | 'IDENTITY_FIELD_REJECTED'
  | 'ALL_CHILDREN_FAILED'
  | 'CHILD_RESULT_INCOMPLETE'
  | 'CHILD_RESULT_MISMATCH'
  | 'APPROVAL_REQUIRED'
  | 'RESUME_INVALID'
  | 'APPROVAL_REJECTED'
  | 'PORT_MISCONFIGURED'

export class DisbursementError extends Error {
  public readonly code: DisbursementErrorCode;
  public readonly retryable: boolean;

  constructor(code: DisbursementErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'DisbursementError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Identity fields the legacy accepted from a client. They are rejected here rather than
 * ignored, so a caller that migrates and still sends one gets a clear error instead of
 * a silent no-op that looks like it worked.
 */
const FORBIDDEN_IDENTITY_FIELDS = [
  'apiKeyId',
  'api_key_id',
  'x-api-key-id',
  'xApiKeyId',
  'apiKey',
  'x-api-key',
  'userId',
  'x-user-id',
  'tenantId',
  'tenant_id',
  'role',
  'adminToken',
  'ADMIN_TOKEN',
] as const;

function assertNoIdentityLeak(input: DisbursementInput): void {
  const raw = input as unknown as Record<string, unknown>;
  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (raw[field] !== undefined) {
      throw new DisbursementError(
        'IDENTITY_FIELD_REJECTED',
        `Disbursement input must not carry an identity field ("${field}"); identity is resolved by the platform, never by the caller`
      );
    }
  }
}

/** Validate and normalise the business input. Fails closed on anything unexpected. */
export function normalizeDisbursementInput(raw: unknown): DisbursementInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DisbursementError('INPUT_INVALID', 'Disbursement input must be an object');
  }
  const input = raw as Record<string, unknown>;

  if (input.inputVersion !== DISBURSEMENT_INPUT_VERSION) {
    throw new DisbursementError(
      'INPUT_INVALID',
      `Unsupported disbursement input version "${String(input.inputVersion)}"; expected "${DISBURSEMENT_INPUT_VERSION}"`
    );
  }

  assertNoIdentityLeak(input as unknown as DisbursementInput);

  const artifactIds = input.artifactIds;
  const fileNames = input.fileNames;
  if (!Array.isArray(artifactIds) || artifactIds.length === 0) {
    throw new DisbursementError('INPUT_INVALID', 'Disbursement input requires at least one artifactId');
  }
  if (!artifactIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
    throw new DisbursementError('INPUT_INVALID', 'Every disbursement artifactId must be a non-empty string');
  }
  if (!Array.isArray(fileNames) || fileNames.length !== artifactIds.length) {
    throw new DisbursementError(
      'INPUT_INVALID',
      'fileNames must be provided and must line up one-to-one with artifactIds');
  }

  const referenceData = Array.isArray(input.referenceData) ? input.referenceData : [];
  if (!referenceData.every((d) => typeof d === 'object' && d !== null && typeof (d as { key?: unknown }).key === 'string')) {
    throw new DisbursementError('INPUT_INVALID', 'Every reference datum requires a string key');
  }

  const policy = input.failurePolicy;
  if (policy !== 'fail-closed' && policy !== 'continue-on-partial') {
    throw new DisbursementError(
      'INPUT_INVALID',
      'failurePolicy must be "fail-closed" or "continue-on-partial"');
  }

  return {
    inputVersion: DISBURSEMENT_INPUT_VERSION,
    artifactIds: artifactIds as string[],
    fileNames: fileNames as string[],
    referenceData: referenceData as DisbursementInput['referenceData'],
    maxConcurrency: resolveConcurrency(typeof input.maxConcurrency === 'number' ? input.maxConcurrency : 2),
    failurePolicy: policy,
    requireEncryptedEvidence: input.requireEncryptedEvidence === true,
  };
}
// ─── Child payload contracts ───────────────────────────────────────────────

/**
 * Discriminated on `kind` so a crosscheck child can never be merged into classify
 * results. The legacy merged on shape alone, which is how a malformed provider reply
 * could quietly become a classified file.
 */
export type ClassifyChildPayload = {
  readonly kind: 'classification';
  readonly fileName: string;
  readonly logicalDocuments: readonly LogicalDocument[];
};

export type ExtractChildPayload = {
  readonly kind: 'extraction';
  readonly fileName: string;
  readonly records: readonly ExtractedRecord[];
};

export type AnyChildPayload = ClassifyChildPayload | ExtractChildPayload;

function isClassifyPayload(value: unknown): value is ClassifyChildPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'classification' &&
    Array.isArray((value as { logicalDocuments?: unknown }).logicalDocuments)
  );
}

function isExtractPayload(value: unknown): value is ExtractChildPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'extraction' &&
    Array.isArray((value as { records?: unknown }).records)
  );
}

// ─── Runtime ───────────────────────────────────────────────────────────────

/**
 * Everything the workflow needs from the host. There is no identity here and no
 * ambient state: the workflow is a function of (input, state, runtime).
 */
export interface DisbursementRuntime {
  readonly ports: DisbursementPorts;
  /** Durable step executor. Sequential stages are checkpointed through it when present. */
  readonly step?: <T>(stepKey: string, inputHash: string, fn: () => Promise<T>) => Promise<T>;
  /** Whether the deployment has an encryption seam. Required when evidence must be sealed. */
  readonly encryptionAvailable?: boolean;
}

// ─── Stage helpers ─────────────────────────────────────────────────────────

function childIdFor(stage: string, fileName: string): string {
  return `${stage}:${fileName}`;
}

function assertFanoutComplete(
  outcomes: readonly FanoutOutcome<unknown>[],
  expected: number
): void {
  if (outcomes.length !== expected) {
    throw new DisbursementError(
      'CHILD_RESULT_INCOMPLETE',
      `Expected ${expected} child results but received ${outcomes.length}`
    );
  }
}

/**
 * Turn fan-out outcomes into a merge, honouring the failure policy.
 *
 * `fail-closed` (the default) refuses to continue when ANY child failed, because a
 * disbursement that silently drops a file reports on fewer documents than it was given.
 * `continue-on-partial` keeps the successes and records the failures as evidence.
 */
function partitionOutcomes<T extends AnyChildPayload>(
  outcomes: readonly FanoutOutcome<unknown>[],
  guard: (value: unknown) => value is T
): { ok: readonly T[]; failed: readonly FanoutOutcome<unknown>[] } {
  const ok: T[] = [];
  const failed: FanoutOutcome<unknown>[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'succeeded' && guard(outcome.payload)) {
      ok.push(outcome.payload);
      continue;
    }
    failed.push(outcome);
  }
  return { ok, failed };
}

function describeFailures(failed: readonly FanoutOutcome<unknown>[]): string {
  return failed
    .map((f) => `${f.childId}: ${f.error?.message ?? 'unknown failure'}`)
    .join('; ');
}

function buildClassifySpecs(input: DisbursementInput): readonly ChildTaskSpec[] {
  return input.artifactIds.map((artifactId, index) => ({
    childId: childIdFor('classify', input.fileNames[index] ?? artifactId),
    stage: 'classify' as const,
    input: { artifactId, fileName: input.fileNames[index] ?? artifactId },
  }));
}

function buildExtractSpecs(
  input: DisbursementInput,
  classifications: readonly FileClassification[]
): readonly ChildTaskSpec[] {
  return input.artifactIds.map((artifactId, index) => {
    const fileName = input.fileNames[index] ?? artifactId;
    return {
      childId: childIdFor('extract', fileName),
      stage: 'extract' as const,
      input: {
        artifactId,
        fileName,
        logicalDocuments: classifications.find((c) => c.fileName === fileName)?.logicalDocuments ?? [],
      },
    };
  });
}

function joinTokenFor(stage: string, inputVersion: string): string {
  return `${stage}@${inputVersion}`;
}

/** True when this stage is the one the workflow is currently waiting on a fan-out for. */
function isPending(state: DisbursementState, stage: string): boolean {
  return state.pendingJoinToken === joinTokenFor(stage, state.inputVersion);
}

/**
 * Consume a join for `stage`, refusing one that belongs to a different fan-out.
 */
function takeJoin(
  state: DisbursementState,
  join: JoinSubmission | undefined,
  stage: string,
  expected: number
): readonly FanoutOutcome<unknown>[] {
  if (join === undefined) {
    throw new DisbursementError('CHILD_RESULT_INCOMPLETE', `No join supplied for ${stage}`);
  }
  const expectedToken = joinTokenFor(stage, state.inputVersion);
  if (join.joinToken !== expectedToken) {
    throw new DisbursementError(
      'CHILD_RESULT_MISMATCH',
      `Join token "${join.joinToken}" does not match the pending ${stage} fan-out "${expectedToken}"`
    );
  }
  assertFanoutComplete(join.results, expected);
  return join.results;
}

// ─── Human approval ────────────────────────────────────────────────────────

export function buildApprovalEvidence(state: DisbursementState): ApprovalEvidence {
  const perFile = state.classifications.map((classification) => ({
    fileName: classification.fileName,
    logicalDocumentCount: classification.logicalDocuments.length,
    extractedCount: state.records.filter((r) => r.fileName === classification.fileName).length,
  }));
  return {
    filesAnalyzed: state.classifications.length,
    logicalDocumentCount: state.classifications.reduce(
      (sum, c) => sum + c.logicalDocuments.length,
      0
    ),
    extractedRecordCount: state.records.length,
    perFile,
  };
}

/**
 * Apply human corrections to extracted records. A correction for a record that does not
 * exist is an error, not a silent insert: approving a fix to something that was never
 * extracted is a data-integrity problem the approver needs to see.
 */
export function applyCorrections(
  records: readonly ExtractedRecord[],
  resume: DisbursementResumeInput
): readonly ExtractedRecord[] {
  if (resume.corrections.length === 0) return records;

  return records.map((record) => {
    const mine = resume.corrections.filter(
      (c) => c.fileName === record.fileName && c.logicalDocumentLabel === record.logicalDocumentLabels[0]
    );
    if (mine.length === 0) return record;
    return { ...record, fields: { ...record.fields, ...Object.fromEntries(mine.map((c) => [c.field, c.value])) } };
  });
}

function assertCorrectionsResolvable(
  records: readonly ExtractedRecord[],
  resume: DisbursementResumeInput
): void {
  for (const correction of resume.corrections) {
    const target = records.find(
      (r) => r.fileName === correction.fileName && r.logicalDocumentLabels[0] === correction.logicalDocumentLabel
    );
    if (!target) {
      throw new DisbursementError(
        'RESUME_INVALID',
        `Correction targets "${correction.fileName}/${correction.logicalDocumentLabel}" which is not an extracted record`
      );
    }
  }
}

function normalizeResume(raw: unknown): DisbursementResumeInput | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DisbursementError('RESUME_INVALID', 'Resume payload must be an object');
  }
  const resume = raw as Record<string, unknown>;
  if (resume.resumeSchemaVersion !== DISBURSEMENT_RESUME_VERSION) {
    throw new DisbursementError(
      'RESUME_INVALID',
      `Unsupported resume schema version "${String(resume.resumeSchemaVersion)}"; expected "${DISBURSEMENT_RESUME_VERSION}"`
    );
  }
  if (typeof resume.approved !== 'boolean') {
    throw new DisbursementError('RESUME_INVALID', 'Resume payload requires an explicit boolean "approved"');
  }
  const corrections = Array.isArray(resume.corrections) ? resume.corrections : [];
  if (
    !corrections.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { fileName?: unknown }).fileName === 'string' &&
        typeof (c as { field?: unknown }).field === 'string'
    )
  ) {
    throw new DisbursementError('RESUME_INVALID', 'Every correction requires a fileName and a field');
  }
  return resume as unknown as DisbursementResumeInput;
}
// ─── Failure policy ────────────────────────────────────────────────────────

function applyFailurePolicy(
  stage: string,
  okCount: number,
  failed: readonly FanoutOutcome<unknown>[],
  expected: number,
  policy: DisbursementInput['failurePolicy']
): void {
  if (failed.length === 0) return;
  const detail = describeFailures(failed);
  if (okCount === 0) {
    throw new DisbursementError(
      'ALL_CHILDREN_FAILED',
      `All ${expected} ${stage} children failed: ${detail}`
    );
  }
  if (policy === 'fail-closed') {
    throw new DisbursementError(
      'CHILD_RESULT_MISMATCH',
      `${stage} fan-out was fail-closed: ${failed.length} of ${expected} children failed: ${detail}`
    );
  }
}

function assertPorts(runtime: DisbursementRuntime): void {
  const ports = runtime?.ports;
  const required = ['classifyFile', 'extractFile', 'crosscheck', 'report'] as const;
  for (const name of required) {
    if (typeof ports?.[name] !== 'function') {
      throw new DisbursementError(
        'PORT_MISCONFIGURED',
        `Disbursement port "${name}" is not implemented by the host`
      );
    }
  }
}

function assertCrosscheckShape(value: unknown): CrosscheckResult {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { findings?: unknown }).findings)) {
    throw new DisbursementError(
      'PORT_MISCONFIGURED',
      'Crosscheck port must resolve to an object with a findings array');
  }
  const result = value as CrosscheckResult;
  if (!Number.isInteger(result.matchedCount) || !Number.isInteger(result.mismatchedCount)) {
    throw new DisbursementError(
      'PORT_MISCONFIGURED',
      'Crosscheck port must resolve integer matchedCount and mismatchedCount');
  }
  if (result.matchedCount < 0 || result.mismatchedCount < 0) {
    throw new DisbursementError(
      'PORT_MISCONFIGURED',
      'Crosscheck counts must not be negative');
  }
  return result;
}

// ─── Public entry point ────────────────────────────────────────────────────

export interface DisbursementResult {
  readonly resultVersion: string;
  readonly businessId: string;
  readonly businessVersion: string;
  readonly report: string;
  readonly crosscheck: CrosscheckResult;
  readonly evidence: ApprovalEvidence;
  /** Failed children, recorded rather than discarded when continue-on-partial is used. */
  readonly failedChildren: readonly { readonly childId: string; readonly reason: string }[];
}

export interface AdvanceRequest {
  readonly input: unknown;
  readonly state?: DisbursementState;
  readonly runtime: DisbursementRuntime;
  /** Present only when answering a wait-for-input. */
  readonly resume?: unknown;
  /** Present only when handing back a completed fan-out; the token must match. */
  readonly join?: JoinSubmission;
}

/**
 * One turn: what to do next, and the state to persist alongside it.
 *
 * The state comes back in the same envelope on purpose. A host that had to reconstruct
 * it would have to re-run the merge, and a merge that is re-run is a merge that can
 * disagree with the one that actually produced the outcome.
 */
export interface DisbursementStep {
  readonly continuation: DisbursementContinuation<DisbursementResult>;
  readonly state: DisbursementState;
}

/**
 * Advance the disbursement workflow by exactly one decision.
 *
 * The host only ever does three mechanical things with the result: run the children,
 * persist a wait, or write a terminal record. Merging, approval gating, cross-checking
 * and reporting all happen in here, where they can be tested without a queue, a
 * database or a provider.
 */
export async function advanceDisbursement(request: AdvanceRequest): Promise<DisbursementStep> {
  const input = normalizeDisbursementInput(request.input);
  const runtime = request.runtime;
  assertPorts(runtime);

  const state = request.state ?? emptyDisbursementState(input.inputVersion);
  if (state.inputVersion !== input.inputVersion) {
    throw new DisbursementError(
      'INPUT_INVALID',
      `State was written for input version "${state.inputVersion}" but the input declares "${input.inputVersion}"`
    );
  }

  const resume = normalizeResume(request.resume);
  let current = state;

  // Child failures are persisted into the state, not a local list: this workflow spans
  // several calls, and a local would forget every failure the moment the next fan-out was
  // issued. `state.childResults` is the durable record.
  const step = (continuation: DisbursementContinuation<DisbursementResult>): DisbursementStep =>
    ({ continuation, state: current });

  const recordFailures = (
    state: DisbursementState,
    failed: readonly FanoutOutcome<unknown>[]
  ): DisbursementState => ({
    ...state,
    childResults: [
      ...state.childResults,
      ...failed.map((outcome) => ({
        childId: outcome.childId,
        status: 'failed' as const,
        error: outcome.error,
      })),
    ],
  });

  // ── Stage 1: classify (bounded fan-out) ──
  if (!current.completedStages.includes(DISBURSEMENT_STEP_IDS.classify)) {
    if (!isPending(current, 'classify')) {
      const joinToken = joinTokenFor('classify', input.inputVersion);
      current = { ...current, pendingJoinToken: joinToken };
      return step({
        kind: 'spawn-children',
        stage: 'classify',
        children: buildClassifySpecs(input),
        maxConcurrency: Math.min(input.maxConcurrency, MAX_FANOUT_CONCURRENCY),
        joinToken,
      });
    }
    const results = takeJoin(current, request.join, 'classify', input.artifactIds.length);
    const { ok, failed } = partitionOutcomes(results, isClassifyPayload);
    applyFailurePolicy('classify', ok.length, failed, input.artifactIds.length, input.failurePolicy);
    current = recordFailures(current, failed);
    current = {
      ...current,
      classifications: ok.map((payload) => ({
        fileName: payload.fileName,
        logicalDocuments: payload.logicalDocuments,
      })),
      completedStages: [...current.completedStages, DISBURSEMENT_STEP_IDS.classify],
      pendingJoinToken: undefined,
    };
  }

  // ── Stage 2: extract (bounded fan-out) ──
  if (!current.completedStages.includes(DISBURSEMENT_STEP_IDS.extract)) {
    if (!isPending(current, 'extract')) {
      const joinToken = joinTokenFor('extract', input.inputVersion);
      current = { ...current, pendingJoinToken: joinToken };
      return step({
        kind: 'spawn-children',
        stage: 'extract',
        children: buildExtractSpecs(input, current.classifications),
        maxConcurrency: Math.min(input.maxConcurrency, MAX_FANOUT_CONCURRENCY),
        joinToken,
      });
    }
    const results = takeJoin(current, request.join, 'extract', input.artifactIds.length);
    const { ok, failed } = partitionOutcomes(results, isExtractPayload);
    applyFailurePolicy('extract', ok.length, failed, input.artifactIds.length, input.failurePolicy);
    current = recordFailures(current, failed);
    current = {
      ...current,
      records: ok.flatMap((payload) => payload.records),
      completedStages: [...current.completedStages, DISBURSEMENT_STEP_IDS.extract],
      pendingJoinToken: undefined,
    };
  }

  // ── Stage 3: human approval ──
  if (!current.completedStages.includes('approval')) {
    if (resume === undefined) {
      if (input.requireEncryptedEvidence && runtime.encryptionAvailable !== true) {
        throw new DisbursementError(
          'PORT_MISCONFIGURED',
          'This disbursement requires sealed approval evidence but the host has no encryption seam; refusing to ask a human to approve unsealed evidence',
          true
        );
      }
      return step({
        kind: 'wait-for-input',
        // The wait is attributed to the stage that produced the evidence under review.
        stage: 'extract',
        prompt: 'Review the extracted disbursement evidence and approve before cross-checking',
        resumeSchemaVersion: DISBURSEMENT_RESUME_VERSION,
        evidenceRef: `disbursement:evidence:${input.inputVersion}:${current.records.length}-records`,
      });
    }
    if (!resume.approved) {
      return step({
        kind: 'terminate',
        terminal: 'FAILED',
        failure: {
          code: 'APPROVAL_REJECTED',
          message: `Disbursement approval was rejected${resume.approvedBy ? ` by ${resume.approvedBy}` : ''}`,
        },
      });
    }
    assertCorrectionsResolvable(current.records, resume);
    current = {
      ...current,
      records: applyCorrections(current.records, resume),
      completedStages: [...current.completedStages, 'approval'],
    };
  }

  // ── Stage 4: crosscheck (sequential, checkpointed) ──
  let crosscheck = current.crosscheck;
  if (crosscheck === undefined) {
    const run = () => runtime.ports.crosscheck({ records: current.records, referenceData: input.referenceData });
    const raw = runtime.step
      ? await runtime.step(
          DISBURSEMENT_STEP_IDS.crosscheck,
          StepCheckpointManager.computeInputHash({ records: current.records, referenceData: input.referenceData }),
          run
        )
      : await run();
    crosscheck = assertCrosscheckShape(raw);
    current = { ...current, crosscheck };
  }

  // ── Stage 5: report (sequential, checkpointed) ──
  let report = current.report;
  if (report === undefined) {
    const run = () =>
      runtime.ports.report({ classifications: current.classifications, records: current.records, crosscheck });
    const raw = runtime.step
      ? await runtime.step(
          DISBURSEMENT_STEP_IDS.report,
          StepCheckpointManager.computeInputHash({ records: current.records }),
          run
        )
      : await run();
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new DisbursementError('PORT_MISCONFIGURED', 'Report port must resolve a non-empty string');
    }
    report = raw;
    current = { ...current, report };
  }

  return step({
    kind: 'terminate',
    terminal: 'SUCCEEDED',
    data: {
      resultVersion: DISBURSEMENT_RESULT_VERSION,
      businessId: DISBURSEMENT_BUSINESS_ID,
      businessVersion: DISBURSEMENT_BUSINESS_VERSION,
      report,
      crosscheck,
      evidence: buildApprovalEvidence(current),
      failedChildren: current.childResults
        .filter((child) => child.status === 'failed')
        .map((child) => ({ childId: child.childId, reason: child.error?.message ?? 'unknown failure' })),
    },
  });
}
// ─── Host-side fan-out bridge ──────────────────────────────────────────────

/**
 * Convenience bridge: run a `spawn-children` outcome through the bounded fan-out and
 * hand the results straight back to `advanceDisbursement`. The host is still free to
 * schedule these on a real queue instead — this is the in-process path that makes the
 * primitive testable without one.
 */
export async function runSpawnedChildren(
  spawn: { readonly children: readonly ChildTaskSpec[]; readonly maxConcurrency: number },
  run: (spec: ChildTaskSpec) => Promise<unknown>
): Promise<readonly FanoutOutcome<unknown>[]> {
  return runBoundedFanout(spawn.children, spawn.maxConcurrency, run);
}