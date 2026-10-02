/**
 * P9-02 LC checker — bounded multi-step business workflow.
 *
 * Stages (dependency order; the orchestrator checkpoints each one):
 *   1. ocr        — bounded fan-out, one child per submitted document
 *   2. screen     — sequential, TEXT ONLY: names the visual checks the text cannot settle
 *   3. visual     — bounded fan-out, one child per requested check, under the same ceiling
 *   4. adjudicate — sequential: the rules base over the text, the digests and the gaps
 *   5. report     — sequential, from an already-validated compliance result
 *
 * Stage 2 and 3 exist because of a real platform limit, not a preference. One connector
 * invocation carries at most 4 artifacts and 10 MiB, inline, while an LC set is 6-12
 * documents. Blanking out on that would make a COMPLIANT verdict structurally unreachable;
 * asking the text what it cannot settle, then opening only those documents, keeps the cost
 * proportional to what actually needs eyes. The refusal of an unsound COMPLIANT verdict is
 * unchanged and is what makes the split safe.
 *
 * Deliberate differences from the legacy implementation, all itemised in the P9-02
 * report:
 *   - Bounded fan-out instead of an unbounded Promise.all.
 *   - The rules base is versioned DATA, not prompt prose, and every discrepancy must
 *     cite a rule id that exists in it. An uncited finding fails the run.
 *   - The verdict and recommendation must follow the rules the examiner was given.
 *     A COMPLIANT verdict over a MAJOR discrepancy is a FAILED run.
 *   - The result always carries humanSignOffRequired. This business produces an
 *     examination, not a legal determination, and the type makes that impossible to
 *     drop rather than something an operator can forget.
 *   - No client-supplied identity. The legacy read apiKeyId from a form field and fell
 *     back to the oldest ADMIN key; here identity is not in the input type at all and
 *     the guard actively rejects it.
 *   - Terminal states are SUCCEEDED and FAILED only. This module never DECLARES a
 *     cancellation; an aborted run surfaces as a thrown error and the platform owns it.
 */

import { LcCheckerError } from './errors';
import { runBoundedFanout, type FanoutOutcome } from './fanout';
import {
  MAX_FANOUT_CONCURRENCY,
  type ChildTaskSpec,
  type JoinSubmission,
  type LcCheckerContinuation,
  type LcCheckerStage,
} from './primitives';
import { getRuleSet, LC_RULE_SET_ID } from './rules/rule-registry';
import {
  LC_CHECKER_INPUT_VERSION,
  LC_CHECKER_RESULT_VERSION,
  emptyLcCheckerState,
  type LcCheckerInput,
  type LcCheckerPorts,
  type LcCheckerState,
  type LcChildResult,
  type LcComplianceResult,
  type LcEvidence,
  type LcVisualDigest,
  type LcVisualRequest,
  type LcVisualVerification,
  type OcrDocumentText,
} from './types';
import type { RuleSetStatus } from './rules/rule-types';
import {
  parseCompliancePayload,
  validateComplianceResult,
  validateScreenResult,
} from './validation';

export const LC_CHECKER_BUSINESS_ID = 'lc-checker' as const;
export const LC_CHECKER_BUSINESS_VERSION = '1.0.0' as const;

/** Stable step ids: they must not change across resumes or checkpoints are orphaned. */
export const LC_CHECKER_STEP_IDS = {
  ocr: 'lc-checker:ocr:v1',
  screen: 'lc-checker:screen:v1',
  visual: 'lc-checker:visual:v1',
  adjudicate: 'lc-checker:adjudicate:v1',
  report: 'lc-checker:report:v1',
} as const;

/** The machine never declares a human sign-off; it always requires one. */
export const LC_HUMAN_SIGNOFF_REQUIRED = true as const;

/**
 * Identity fields the legacy accepted from a client. They are rejected here rather than
 * ignored, so a caller that migrates and still sends one gets a clear error instead of a
 * silent no-op that looks like it worked.
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

/** The legacy route accepted any number of files; a documentary credit set is bounded. */
export const MAX_LC_DOCUMENTS = 50;

function assertNoIdentityLeak(input: LcCheckerInput): void {
  const raw = input as unknown as Record<string, unknown>;
  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (raw[field] !== undefined) {
      throw new LcCheckerError(
        'IDENTITY_FIELD_REJECTED',
        'LC checker input must not carry an identity field ("' +
          field +
          '"); identity is resolved by the platform, never by the caller'
      );
    }
  }
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LcCheckerError('INPUT_INVALID', label + ' must be a non-empty array');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new LcCheckerError('INPUT_INVALID', label + '[' + index + '] must be a non-empty string');
    }
    return entry;
  });
}

/** Validate and normalise the business input. Fails closed on anything unexpected. */
export function normalizeLcCheckerInput(raw: unknown): LcCheckerInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LcCheckerError('INPUT_INVALID', 'LC checker input must be an object');
  }
  const input = raw as Record<string, unknown>;

  // Checked on the RAW record, before normalisation drops anything. Checked afterwards
  // the guard can never fire, because normalisation only copies fields it recognises.
  assertNoIdentityLeak(input as unknown as LcCheckerInput);

  if (input['inputVersion'] !== LC_CHECKER_INPUT_VERSION) {
    throw new LcCheckerError(
      'INPUT_INVALID',
      'Unsupported LC checker input version "' +
        String(input['inputVersion']) +
        '"; expected "' +
        LC_CHECKER_INPUT_VERSION +
        '"'
    );
  }

  const artifactIds = requireStringArray(input['artifactIds'], 'artifactIds');
  const fileNames = requireStringArray(input['fileNames'], 'fileNames');

  if (artifactIds.length !== fileNames.length) {
    throw new LcCheckerError(
      'INPUT_INVALID',
      'artifactIds and fileNames must be the same length; got ' +
        artifactIds.length +
        ' and ' +
        fileNames.length
    );
  }
  if (artifactIds.length > MAX_LC_DOCUMENTS) {
    throw new LcCheckerError(
      'INPUT_INVALID',
      'An LC document set is limited to ' + MAX_LC_DOCUMENTS + ' documents; got ' + artifactIds.length
    );
  }

  const ruleSetVersion = input['ruleSetVersion'];
  if (typeof ruleSetVersion !== 'string' || ruleSetVersion.trim().length === 0) {
    throw new LcCheckerError('INPUT_INVALID', 'ruleSetVersion is required');
  }
  if (!getRuleSet(ruleSetVersion)) {
    throw new LcCheckerError('RULESET_UNKNOWN', 'Unknown LC ruleset version "' + ruleSetVersion + '"');
  }

  const maxConcurrency = input['maxConcurrency'];
  if (typeof maxConcurrency !== 'number' || !Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new LcCheckerError('INPUT_INVALID', 'maxConcurrency must be a positive integer');
  }

  const failurePolicy = input['failurePolicy'];
  if (failurePolicy !== 'fail-closed' && failurePolicy !== 'continue-on-partial') {
    throw new LcCheckerError(
      'INPUT_INVALID',
      'failurePolicy must be "fail-closed" or "continue-on-partial"'
    );
  }

  if (typeof input['requireEncryptedEvidence'] !== 'boolean') {
    throw new LcCheckerError('INPUT_INVALID', 'requireEncryptedEvidence must be a boolean');
  }

  const normalized: LcCheckerInput = {
    inputVersion: LC_CHECKER_INPUT_VERSION,
    artifactIds,
    fileNames,
    ruleSetVersion: ruleSetVersion.trim(),
    maxConcurrency: Math.min(maxConcurrency, MAX_FANOUT_CONCURRENCY),
    failurePolicy,
    requireEncryptedEvidence: input['requireEncryptedEvidence'],
  };

  return normalized;
}

export type OcrChildPayload = {
  readonly kind: 'ocr';
  readonly fileName: string;
  readonly text: string;
};

export type VisualChildPayload = LcVisualDigest;

function isVisualPayload(value: unknown): value is LcVisualDigest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['documentIndex'] === 'number' &&
    typeof record['purpose'] === 'string' &&
    Array.isArray(record['observations']) &&
    record['observations'].length > 0
  );
}

export type AnyChildPayload = OcrChildPayload;

function isOcrPayload(value: unknown): value is OcrChildPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['kind'] === 'ocr' &&
    typeof record['fileName'] === 'string' &&
    typeof record['text'] === 'string'
  );
}

function childIdFor(fileName: string): string {
  return 'ocr:' + fileName;
}

function joinTokenFor(stage: LcCheckerStage, inputVersion: string): string {
  return stage + ':' + inputVersion;
}

function buildOcrSpecs(input: LcCheckerInput): readonly ChildTaskSpec[] {
  return input.fileNames.map((fileName, index) => ({
    childId: childIdFor(fileName),
    stage: 'ocr' as const,
    input: { artifactId: input.artifactIds[index], fileName },
  }));
}

function isPending(state: LcCheckerState, stage: LcCheckerStage): boolean {
  return state.pendingJoinToken === joinTokenFor(stage, state.inputVersion);
}

/** The fan-out stage a pending join token belongs to, or undefined when none is pending. */
function pendingStage(state: LcCheckerState): LcCheckerStage | undefined {
  for (const stage of ['ocr', 'visual'] as const) {
    if (isPending(state, stage)) return stage;
  }
  return undefined;
}

function buildVisualSpecs(
  input: LcCheckerInput,
  requests: readonly LcVisualRequest[]
): readonly ChildTaskSpec[] {
  return requests.map((entry, index) => ({
    // Indexed by position so two checks on the SAME document get different children; a
    // bill of lading can need the reverse endorsement AND the on-board notation.
    childId: 'visual:' + index + ':' + childIdFor(input.fileNames[entry.documentIndex] ?? ''),
    stage: 'visual' as const,
    input: {
      artifactId: input.artifactIds[entry.documentIndex],
      fileName: input.fileNames[entry.documentIndex],
      documentIndex: entry.documentIndex,
      purpose: entry.purpose,
      ruleIds: entry.ruleIds,
      ruleSetVersion: input.ruleSetVersion,
    },
  }));
}

function partitionVisualOutcomes(outcomes: readonly FanoutOutcome<unknown>[]): {
  readonly ok: readonly LcVisualDigest[];
  readonly failed: readonly FanoutOutcome<unknown>[];
} {
  const ok: LcVisualDigest[] = [];
  const failed: FanoutOutcome<unknown>[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'succeeded' && isVisualPayload(outcome.payload)) {
      ok.push(outcome.payload);
    } else {
      failed.push(outcome);
    }
  }
  return { ok, failed };
}

/** Screening questions that no digest answered. A gap the result must be able to show. */
export function outstandingVisualChecks(
  state: LcCheckerState,
  fileNames: readonly string[]
): readonly { readonly fileName: string; readonly purpose: string }[] {
  const requests = state.screen?.visualRequests ?? [];
  const satisfied = new Set(state.visualDigests.map((digest) => digest.purpose));
  return requests
    .filter((entry) => !satisfied.has(entry.purpose))
    .map((entry) => ({ fileName: fileNames[entry.documentIndex] ?? 'document ' + entry.documentIndex, purpose: entry.purpose }));
}

function takeJoin(
  state: LcCheckerState,
  join: JoinSubmission<unknown> | undefined,
  stage: LcCheckerStage,
  expectedCount: number
): readonly FanoutOutcome<unknown>[] {
  const expectedToken = joinTokenFor(stage, state.inputVersion);
  if (!isPending(state, stage)) {
    throw new LcCheckerError(
      'CHILD_RESULT_MISMATCH',
      'A join arrived for stage "' + stage + '" but no fan-out is pending for it'
    );
  }
  if (!join) {
    throw new LcCheckerError(
      'CHILD_RESULT_INCOMPLETE',
      'Stage "' + stage + '" is waiting for a join and none was supplied'
    );
  }
  if (join.joinToken !== expectedToken) {
    throw new LcCheckerError(
      'CHILD_RESULT_MISMATCH',
      'Join token "' + join.joinToken + '" does not match the pending token for stage "' + stage + '"'
    );
  }
  if (join.results.length !== expectedCount) {
    throw new LcCheckerError(
      'CHILD_RESULT_INCOMPLETE',
      'Stage "' +
        stage +
        '" expected ' +
        expectedCount +
        ' child results but received ' +
        join.results.length
    );
  }
  return join.results;
}

function describeFailures(failed: readonly FanoutOutcome<unknown>[]): string {
  return failed
    .map((outcome) => outcome.childId + ': ' + (outcome.error?.message ?? 'unknown failure'))
    .join('; ');
}

function partitionOutcomes(
  outcomes: readonly FanoutOutcome<unknown>[]
): { readonly ok: readonly AnyChildPayload[]; readonly failed: readonly FanoutOutcome<unknown>[] } {
  const ok: AnyChildPayload[] = [];
  const failed: FanoutOutcome<unknown>[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'succeeded' && isOcrPayload(outcome.payload)) {
      ok.push(outcome.payload);
    } else {
      failed.push(outcome);
    }
  }
  return { ok, failed };
}

function assertPorts(runtime: LcCheckerPorts | undefined): LcCheckerPorts {
  if (
    !runtime ||
    typeof runtime.ocrFile !== 'function' ||
    typeof runtime.screen !== 'function' ||
    typeof runtime.inspect !== 'function' ||
    typeof runtime.adjudicate !== 'function' ||
    typeof runtime.generateReport !== 'function'
  ) {
    throw new LcCheckerError(
      'PORT_MISCONFIGURED',
      'LC checker requires the ocrFile, screen, inspect, adjudicate and generateReport ports'
    );
  }
  return runtime;
}

export function buildEvidence(state: LcCheckerState): LcEvidence {
  const ruleSet = getRuleSet(state.ruleSetVersion);
  const cited = new Set<string>();
  for (const entry of state.compliance?.discrepancies ?? []) {
    cited.add(entry.ruleId);
  }
  return {
    filesSubmitted: state.completedStages.includes(LC_CHECKER_STEP_IDS.ocr) ? state.ocrTexts.length : 0,
    filesOcred: state.ocrTexts.filter((entry) => entry.fromOcr).length,
    filesWithoutOcrText: state.ocrTexts.filter((entry) => !entry.fromOcr).map((entry) => entry.fileName),
    totalOcrChars: state.ocrTexts.reduce((sum, entry) => sum + entry.charCount, 0),
    ruleSetId: ruleSet?.id ?? LC_RULE_SET_ID,
    ruleSetVersion: state.ruleSetVersion,
    ruleSetStatus: (ruleSet?.status ?? 'PROVISIONAL') as RuleSetStatus,
    citedRuleIds: [...cited].sort(),
    // Absent means the adjudication has not run yet, which is NOT the same as a complete
    // visual verification. Defaulting to complete would let a pre-examination build
    // claim sight it never had.
    visualVerification: state.visualVerification ?? { requested: 0, satisfied: 0, complete: false },
  };
}

export interface LcCheckerResult {
  readonly resultVersion: string;
  readonly businessId: string;
  readonly businessVersion: string;
  readonly verdict: LcComplianceResult['verdict'];
  readonly recommendation: LcComplianceResult['recommendation'];
  readonly totalDiscrepancies: number;
  readonly majorDiscrepancies: number;
  readonly minorDiscrepancies: number;
  readonly advisoryCount: number;
  readonly documentsPresent: readonly string[];
  readonly documentsMissing: readonly string[];
  readonly discrepancies: LcComplianceResult['discrepancies'];
  readonly summary: string;
  readonly report: string;
  readonly evidence: LcEvidence;
  /** Always true. See LC_HUMAN_SIGNOFF_REQUIRED. */
  readonly humanSignOffRequired: typeof LC_HUMAN_SIGNOFF_REQUIRED;
  /** Failed OCR children, recorded rather than discarded under continue-on-partial. */
  readonly failedChildren: readonly { readonly childId: string; readonly reason: string }[];
  /** Screening questions that inspection could not answer, so a gap is never silent. */
  readonly outstandingVisualChecks: readonly { readonly fileName: string; readonly purpose: string }[];
}

export interface AdvanceRequest {
  readonly input: unknown;
  readonly state?: LcCheckerState;
  readonly runtime: LcCheckerPorts;
  /** Present only when handing back a completed OCR fan-out; the token must match. */
  readonly join?: JoinSubmission<unknown>;
}

/**
 * One turn: what to do next, and the state to persist alongside it.
 *
 * The state comes back in the same envelope on purpose. A host that had to reconstruct it
 * would have to re-run the merge, and a merge that is re-run is a merge that can disagree
 * with the one that actually produced the outcome.
 */
export interface LcCheckerStep {
  readonly continuation: LcCheckerContinuation<LcCheckerResult>;
  readonly state: LcCheckerState;
}

function ocrTextFor(fileName: string, payload: OcrChildPayload | undefined): OcrDocumentText {
  const text = payload?.text ?? '';
  return {
    fileName,
    text,
    fromOcr: text.length > 0,
    charCount: text.length,
  };
}

/**
 * Advance the LC checker by exactly one decision.
 *
 * The host only ever does two mechanical things with the result: run the children, or
 * write a terminal record. Everything else — merging, failure policy, examination,
 * validation, reporting — happens in here, where it can be tested without a queue, a
 * database or a provider.
 */
export async function advanceLcChecker(request: AdvanceRequest): Promise<LcCheckerStep> {
  const input = normalizeLcCheckerInput(request.input);
  const runtime = assertPorts(request.runtime);

  let state = request.state ?? emptyLcCheckerState(input.inputVersion, input.ruleSetVersion);
  if (state.inputVersion !== input.inputVersion) {
    throw new LcCheckerError(
      'INPUT_INVALID',
      'State was written for input version "' + state.inputVersion + '" but the input declares "' + input.inputVersion + '"'
    );
  }
  if (state.ruleSetVersion !== input.ruleSetVersion) {
    throw new LcCheckerError(
      'RULESET_UNKNOWN',
      'State was examined against ruleset "' +
        state.ruleSetVersion +
        '" but the input declares "' +
        input.ruleSetVersion +
        '"; a run cannot change its rules base mid-flight'
    );
  }

  const step = (continuation: LcCheckerContinuation<LcCheckerResult>): LcCheckerStep => ({
    continuation,
    state,
  });

  // A join must match a fan-out this run actually issued. With two fan-out stages an
  // unmatched join is just as wrong as with one: it is a duplicate delivery, or a result
  // for a round that never happened. Re-issuing the fan-out instead would let the host
  // retry into a silent loop, so it is refused.
  const awaiting = pendingStage(state);
  if (request.join && awaiting === undefined) {
    throw new LcCheckerError(
      'CHILD_RESULT_MISMATCH',
      'A join was supplied while no fan-out is pending for it'
    );
  }

  // ── Stage 1: ocr (bounded fan-out) ──
  if (!state.completedStages.includes(LC_CHECKER_STEP_IDS.ocr)) {
    if (!isPending(state, 'ocr')) {
      const joinToken = joinTokenFor('ocr', input.inputVersion);
      state = { ...state, pendingJoinToken: joinToken };
      return step({
        kind: 'spawn-children',
        stage: 'ocr',
        children: buildOcrSpecs(input),
        maxConcurrency: input.maxConcurrency,
        joinToken,
      });
    }

    const results = takeJoin(state, request.join, 'ocr', input.artifactIds.length);
    const { ok, failed } = partitionOutcomes(results);

    // The legacy examined whatever survived: OCR errors were isolated per file and the
    // compliance step still received the original PDFs. fail-closed refuses only when
    // there is nothing at all to examine; continue-on-partial reproduces the legacy path
    // and records the failures instead of swallowing them.
    if (input.failurePolicy === 'fail-closed' && ok.length === 0) {
      throw new LcCheckerError(
        'ALL_CHILDREN_FAILED',
        'No document could be read, so there is nothing to examine: ' + describeFailures(failed),
        true
      );
    }

    const byFile = new Map(ok.map((payload) => [payload.fileName, payload] as const));
    const ocrTexts = input.fileNames.map((fileName) => ocrTextFor(fileName, byFile.get(fileName)));

    const childResults: readonly LcChildResult[] = input.fileNames.map((fileName) => {
      const failedOutcome = failed.find((outcome) => outcome.childId === childIdFor(fileName));
      if (failedOutcome) {
        return {
          childId: failedOutcome.childId,
          fileName,
          status: 'failed' as const,
          error: failedOutcome.error ?? { code: 'CHILD_FAILED', message: 'unknown failure' },
        };
      }
      return { childId: childIdFor(fileName), fileName, status: 'succeeded' as const };
    });

    state = {
      ...state,
      ocrTexts,
      // Persisted, not a local: this workflow spans several calls and a local would
      // forget every failure the moment the next turn was issued.
      childResults,
      completedStages: [...state.completedStages, LC_CHECKER_STEP_IDS.ocr],
      pendingJoinToken: undefined,
    };
  }

  // ── Stage 2: screen (sequential, text only) ──
  if (!state.completedStages.includes(LC_CHECKER_STEP_IDS.screen)) {
    const raw = await runtime.screen({
      ocrTexts: state.ocrTexts,
      fileNames: input.fileNames,
      ruleSetVersion: input.ruleSetVersion,
    });
    const screen = validateScreenResult(raw, input.ruleSetVersion, input.fileNames.length);
    state = {
      ...state,
      screen,
      completedStages: [...state.completedStages, LC_CHECKER_STEP_IDS.screen],
    };
  }

  const requests = state.screen?.visualRequests ?? [];

  // ── Stage 3: visual (bounded fan-out, only when screening asked for something) ──
  if (!state.completedStages.includes(LC_CHECKER_STEP_IDS.visual)) {
    if (requests.length === 0) {
      // Nothing the text could not settle. Skipping the round is the whole point of
      // asking first, so a clean set costs one examination instead of two.
      state = { ...state, completedStages: [...state.completedStages, LC_CHECKER_STEP_IDS.visual] };
    } else if (!isPending(state, 'visual')) {
      const joinToken = joinTokenFor('visual', input.inputVersion);
      state = { ...state, pendingJoinToken: joinToken };
      return step({
        kind: 'spawn-children',
        stage: 'visual',
        children: buildVisualSpecs(input, requests),
        maxConcurrency: input.maxConcurrency,
        joinToken,
      });
    } else {
      const results = takeJoin(state, request.join, 'visual', requests.length);
      const { ok, failed } = partitionVisualOutcomes(results);
      state = {
        ...state,
        visualDigests: ok,
        visualFailures: failed.map((outcome) => ({
          request: outcome.childId,
          reason: outcome.error?.message ?? 'unknown failure',
        })),
        completedStages: [...state.completedStages, LC_CHECKER_STEP_IDS.visual],
        pendingJoinToken: undefined,
      };
    }
  }

  // ── Stage 4: adjudicate (sequential) ──
  if (!state.completedStages.includes(LC_CHECKER_STEP_IDS.adjudicate)) {
    const satisfied = new Set(state.visualDigests.map((digest) => digest.purpose));
    const outstanding = requests.filter((entry) => !satisfied.has(entry.purpose));
    // Completeness is computed HERE, not taken from the port. A host that declared its own
    // examination complete would be able to certify checks nobody performed, which is the
    // one thing this whole split exists to prevent.
    const visualVerification: LcVisualVerification = {
      requested: requests.length,
      satisfied: state.visualDigests.length,
      complete: state.visualDigests.length === requests.length,
    };

    const raw = await runtime.adjudicate({
      ocrTexts: state.ocrTexts,
      visualDigests: state.visualDigests,
      outstandingChecks: outstanding,
      screenNotes: state.screen?.notes ?? '',
      fileNames: input.fileNames,
      ruleSetVersion: input.ruleSetVersion,
    });
    const compliance = validateComplianceResult(
      parseCompliancePayload(raw),
      input.ruleSetVersion
    );

    // A COMPLIANT verdict means every check that mattered was actually performed. If the
    // inspection pass could not answer a screening question, then a signature, a stamp or
    // an endorsement went unchecked, and a clean verdict over that is not a finding.
    // Refused here rather than quietly downgraded.
    if (compliance.verdict === 'COMPLIANT' && !visualVerification.complete) {
      throw new LcCheckerError(
        'COMPLIANCE_INVALID',
        'A COMPLIANT verdict was returned while ' +
          visualVerification.satisfied +
          ' of ' +
          visualVerification.requested +
          ' visual checks were satisfied; the ones still outstanding could carry a MAJOR deviation'
      );
    }

    state = {
      ...state,
      compliance,
      visualVerification,
      completedStages: [...state.completedStages, LC_CHECKER_STEP_IDS.adjudicate],
    };
  }

  // ── Stage 5: report (sequential) ──
  let report = state.report;
  if (!state.completedStages.includes(LC_CHECKER_STEP_IDS.report)) {
    const compliance = state.compliance;
    if (!compliance) {
      throw new LcCheckerError('CHILD_RESULT_INCOMPLETE', 'The report stage ran without a compliance result');
    }
    report = await runtime.generateReport({
      compliance,
      evidence: buildEvidence(state),
    });
    if (typeof report !== 'string' || report.trim().length === 0) {
      throw new LcCheckerError('CHILD_RESULT_INCOMPLETE', 'The report port returned no report text', true);
    }
    state = {
      ...state,
      report,
      completedStages: [...state.completedStages, LC_CHECKER_STEP_IDS.report],
    };
  }

  const compliance = state.compliance;
  if (!compliance || !report) {
    throw new LcCheckerError('CHILD_RESULT_INCOMPLETE', 'The workflow reached the end without a complete examination');
  }

  return step({
    kind: 'terminate',
    terminal: 'SUCCEEDED',
    data: {
      resultVersion: LC_CHECKER_RESULT_VERSION,
      businessId: LC_CHECKER_BUSINESS_ID,
      businessVersion: LC_CHECKER_BUSINESS_VERSION,
      verdict: compliance.verdict,
      recommendation: compliance.recommendation,
      totalDiscrepancies: compliance.totalDiscrepancies,
      majorDiscrepancies: compliance.majorDiscrepancies,
      minorDiscrepancies: compliance.minorDiscrepancies,
      advisoryCount: compliance.advisoryCount,
      documentsPresent: compliance.documentsPresent,
      documentsMissing: compliance.documentsMissing,
      discrepancies: compliance.discrepancies,
      summary: compliance.summary,
      report,
      evidence: buildEvidence(state),
      humanSignOffRequired: LC_HUMAN_SIGNOFF_REQUIRED,
      failedChildren: state.childResults
        .filter((child) => child.status === 'failed')
        .map((child) => ({ childId: child.childId, reason: child.error?.message ?? 'unknown failure' })),
      outstandingVisualChecks: outstandingVisualChecks(state, input.fileNames),
    },
  });
}

/**
 * Host-side fan-out bridge. Run a `spawn-children` outcome through the bounded fan-out
 * and hand the results straight back to advanceLcChecker. The host is still free to
 * schedule these on a real queue instead; this is the in-process path that makes the
 * primitive testable without one.
 */
export async function runSpawnedChildren(
  spawn: { readonly children: readonly ChildTaskSpec[]; readonly maxConcurrency: number },
  run: (spec: ChildTaskSpec) => Promise<unknown>
): Promise<readonly FanoutOutcome<unknown>[]> {
  return runBoundedFanout(spawn.children, spawn.maxConcurrency, run);
}
