/**
 * Worker adapter: TaskContext in, TaskDisposition out.
 *
 * The business logic lives in lc-checker.ts and knows nothing about the platform. This
 * file is the only place that speaks TaskContext, and it does four mechanical things:
 * persist the machine's state between deliveries, turn a join into the shape the machine
 * expects, call a connector slot through the SDK, and hand the machine its ports.
 *
 * STATE ACROSS DELIVERIES. The workflow now spans up to three deliveries: plan the OCR
 * fan-out, receive the OCR join, receive the visual join. The machine's state has to
 * survive between them, and a handler cannot read a step checkpoint's payload back, so the
 * state is written as an INTERMEDIATE artifact under a name derived from the operation id.
 * The name is deterministic, so any delivery of the same operation finds the same state
 * without a lookup, and a redelivery resumes instead of re-examining.
 *
 * JOIN CONTRACT CAVEAT. Joined child results arrive as ctx.input.joinSummary, a
 * taskKey -> resultRef map. example-review reads the same shape and carries the same
 * caveat (review.ts:837): the authoritative typed continuation contract is still owned by
 * the platform lane. A missing or unparseable child becomes an explicit FAILED outcome
 * rather than a shorter list, so a short round is a recorded gap and never a silent
 * downgrade of the examination.
 */

import {
  CONNECTOR_ARTIFACT_MAX_BYTES,
  CONNECTOR_ARTIFACT_MAX_COUNT,
  contentHash,
} from '@du/contracts';
import type { ChildTaskSpecInput, TaskContext, TaskDisposition, TaskHandler } from '@du/worker-sdk';
import {
  BusinessDefinition,
  defineBusiness,
  startWorker,
  type WorkerConfig,
  type WorkerHandle,
} from '@du/worker-sdk';

import { LcCheckerError } from './errors';
import { legacyLcCheckerHandler } from './legacy-workflow';
import {
  LC_CHECKER_STEP_IDS,
  advanceLcChecker,
  normalizeLcCheckerInput,
  type LcCheckerResult,
} from './lc-checker';
import type { ChildOutcome } from './primitives';
import { lcCheckerManifest } from './manifest';
import { buildOcrPrompt } from './rules/ocr-prompt';
import {
  buildAdjudicationPrompt,
  buildInspectionPrompt,
  buildReportPrompt,
  buildScreenPrompt,
} from './rules/prompt-builders';
import { getRuleSet } from './rules/rule-registry';
import { MAX_VISUAL_REQUESTS, parseCompliancePayload, validateVisualDigest } from './validation';
import type { LcCheckerPorts, LcCheckerState, LcVisualDigest, LcVisualRequest } from './types';

const OCR_SLOT = 'ocr';
const VISION_SLOT = 'vision';
const CROSSCHECK_SLOT = 'crosscheck';
const REPORT_SLOT = 'report';
const OCR_CHILD_KIND = 'lc-checker-ocr';
const VISUAL_CHILD_KIND = 'lc-checker-visual';

function assertActive(ctx: TaskContext): void {
  if (ctx.cancelRequested) {
    throw new LcCheckerError('PORT_MISCONFIGURED', 'Cancellation was requested for this operation');
  }
  if (ctx.signal.aborted) {
    throw new LcCheckerError('PORT_MISCONFIGURED', 'The task lease was lost or shutdown began');
  }
}

function stateArtifactName(operationId: string): string {
  return 'lc-checker-state-' + operationId + '.json';
}

/** Absent on the first delivery of an operation; that is the only expected absence. */
async function loadState(ctx: TaskContext): Promise<LcCheckerState | undefined> {
  try {
    const read = await ctx.artifacts.readWithMetadata(stateArtifactName(ctx.operationId), { signal: ctx.signal });
    return JSON.parse(read.buffer.toString('utf8')) as LcCheckerState;
  } catch {
    return undefined;
  }
}

async function saveState(ctx: TaskContext, state: LcCheckerState): Promise<void> {
  await ctx.artifacts.write(
    JSON.stringify(state),
    stateArtifactName(ctx.operationId),
    'application/json',
    'intermediate'
  );
}

interface InlinedArtifact {
  readonly artifactId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageVersionId: string;
  readonly contentBase64: string;
}

/**
 * Read an authorized artifact and inline it for a connector invocation.
 *
 * The connector contract carries content inline, not an id, so the bytes are fetched here
 * through the granted facade. Size is checked against the contract cap before the call
 * rather than after: an oversized payload would be rejected by the connector, and a
 * rejection at that point is far harder to attribute than a refusal here.
 */
async function inlineArtifact(
  ctx: TaskContext,
  artifactId: string,
  fileName: string
): Promise<InlinedArtifact> {
  const read = await ctx.artifacts.readWithMetadata(artifactId, { signal: ctx.signal });
  if (read.sizeBytes > CONNECTOR_ARTIFACT_MAX_BYTES) {
    throw new LcCheckerError(
      'PORT_MISCONFIGURED',
      'Artifact ' +
        fileName +
        ' is ' +
        read.sizeBytes +
        ' bytes, above the connector limit of ' +
        CONNECTOR_ARTIFACT_MAX_BYTES +
        ' bytes; it cannot be examined'
    );
  }
  return {
    artifactId,
    fileName: read.filename ?? fileName,
    mimeType: read.mimeType ?? 'application/octet-stream',
    sizeBytes: read.sizeBytes,
    sha256: read.sha256,
    storageVersionId: read.storageVersionId ?? '',
    contentBase64: read.buffer.toString('base64'),
  };
}

function decodeInline(resultRef: string, taskKey: string): Record<string, unknown> {
  if (!resultRef.startsWith('data:')) {
    throw new LcCheckerError(
      'CHILD_RESULT_MISMATCH',
      'Child result for ' + taskKey + ' is a durable artifactId; the inline join contract expects a data: reference'
    );
  }
  const separator = resultRef.indexOf(',');
  if (separator < 0 || !resultRef.slice(0, separator).endsWith(';base64')) {
    throw new LcCheckerError('CHILD_RESULT_MISMATCH', 'Child result for ' + taskKey + ' has an invalid data reference');
  }
  const decoded = Buffer.from(resultRef.slice(separator + 1), 'base64').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new LcCheckerError('CHILD_RESULT_MISMATCH', 'Child result for ' + taskKey + ' is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LcCheckerError('CHILD_RESULT_MISMATCH', 'Child result for ' + taskKey + ' is not an object');
  }
  return parsed as Record<string, unknown>;
}

function encodeInline(payload: unknown): string {
  return 'data:application/json;base64,' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function joinSummaryOf(ctx: TaskContext): Readonly<Record<string, unknown>> {
  const raw = ctx.input['joinSummary'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

/**
 * Turn the platform's taskKey -> resultRef map into the machine's childId -> outcome list.
 *
 * Two details matter. The map is keyed, never positional, because object key order is not
 * a contract. And a task key the platform did not return becomes an explicit FAILED
 * outcome, so the machine records a gap instead of examining a smaller set than it was
 * given.
 */
function buildOcrJoin(
  ctx: TaskContext,
  fileNames: readonly string[],
  inputVersion: string
): { readonly joinToken: string; readonly results: readonly ChildOutcome<unknown>[] } {
  const summary = joinSummaryOf(ctx);
  const results = fileNames.map((fileName, index) => {
    const ref = summary['ocr-' + index];
    if (typeof ref !== 'string') {
      return {
        childId: 'ocr:' + fileName,
        status: 'failed' as const,
        error: { code: 'CHILD_RESULT_MISSING', message: 'The platform returned no OCR result for ' + fileName },
      };
    }
    const parsed = decodeInline(ref, 'ocr-' + index);
    if (parsed['kind'] !== 'ocr' || typeof parsed['text'] !== 'string') {
      throw new LcCheckerError('CHILD_RESULT_MISMATCH', 'Child result for ocr-' + index + ' is not an OCR payload');
    }
    return {
      childId: 'ocr:' + fileName,
      status: 'succeeded' as const,
      payload: { kind: 'ocr' as const, fileName, text: parsed['text'] },
    };
  });
  return { joinToken: 'ocr:' + inputVersion, results };
}

function buildVisualJoin(
  ctx: TaskContext,
  requests: readonly LcVisualRequest[],
  fileNames: readonly string[],
  inputVersion: string
): { readonly joinToken: string; readonly results: readonly ChildOutcome<unknown>[] } {
  const summary = joinSummaryOf(ctx);
  const results = requests.map((request, index) => {
    const ref = summary['visual-' + index];
    const fileName = fileNames[request.documentIndex] ?? 'document ' + request.documentIndex;
    if (typeof ref !== 'string') {
      return {
        childId: 'visual:' + index + ':ocr:' + fileName,
        status: 'failed' as const,
        error: { code: 'CHILD_RESULT_MISSING', message: 'No inspection result for ' + fileName },
      };
    }
    const digest: LcVisualDigest = validateVisualDigest(
      decodeInline(ref, 'visual-' + index),
      request,
      fileName,
      fileNames.length
    );
    return {
      childId: 'visual:' + index + ':ocr:' + fileName,
      status: 'succeeded' as const,
      payload: digest,
    };
  });
  return { joinToken: 'visual:' + inputVersion, results };
}

function parseChildInput(ctx: TaskContext): { artifactId: string; fileName: string } {
  const artifactId = ctx.input['artifactId'];
  const fileName = ctx.input['fileName'];
  if (typeof artifactId !== 'string' || artifactId.length === 0) {
    throw new LcCheckerError('CHILD_RESULT_INCOMPLETE', 'Child input is missing artifactId');
  }
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new LcCheckerError('CHILD_RESULT_INCOMPLETE', 'Child input is missing fileName');
  }
  return { artifactId, fileName };
}

/** Stage 1 child: OCR one document into Markdown. */
export const ocrChildHandler: TaskHandler = async (ctx: TaskContext): Promise<TaskDisposition> => {
  assertActive(ctx);
  const { artifactId, fileName } = parseChildInput(ctx);

  const text = await ctx.step.run(LC_CHECKER_STEP_IDS.ocr + ':' + fileName, artifactId, async () => {
    const response = await ctx.connector.invoke(OCR_SLOT, {
      prompt: buildOcrPrompt(fileName),
      artifacts: [await inlineArtifact(ctx, artifactId, fileName)],
    });
    if (response.state !== 'SUCCEEDED') {
      throw new LcCheckerError('PORT_MISCONFIGURED', 'The OCR provider returned state ' + response.state, true);
    }
    return response.result?.content ?? '';
  });

  return { kind: 'completed', resultRef: encodeInline({ kind: 'ocr', fileName, text }) };
};

/**
 * Stage 3 child: look at ONE document and answer ONE question about it.
 *
 * The rules that question serves are passed in by the screening pass, and only those rules
 * are rendered into the prompt. That is what keeps the second pass affordable: inspecting
 * an endorsement does not need the insurance paragraph in the context window.
 */
export const visualChildHandler: TaskHandler = async (ctx: TaskContext): Promise<TaskDisposition> => {
  assertActive(ctx);
  const { artifactId, fileName } = parseChildInput(ctx);
  const documentIndex = ctx.input['documentIndex'];
  const purpose = ctx.input['purpose'];
  const ruleIds = ctx.input['ruleIds'];
  const ruleSetVersion = ctx.input['ruleSetVersion'];
  if (typeof documentIndex !== 'number' || typeof purpose !== 'string') {
    throw new LcCheckerError('CHILD_RESULT_INCOMPLETE', 'Inspection child input is missing documentIndex or purpose');
  }
  if (!Array.isArray(ruleIds) || typeof ruleSetVersion !== 'string') {
    throw new LcCheckerError('CHILD_RESULT_INCOMPLETE', 'Inspection child input is missing ruleIds or ruleSetVersion');
  }

  const payload = await ctx.step.run(
    LC_CHECKER_STEP_IDS.visual + ':' + documentIndex + ':' + purpose,
    contentHash({ artifactId, purpose, ruleIds }),
    async () => {
      const response = await ctx.connector.invoke(VISION_SLOT, {
        prompt: buildInspectionPrompt({
          fileName,
          documentIndex,
          purpose,
          ruleIds: ruleIds as string[],
          ruleSetVersion,
        }),
        artifacts: [await inlineArtifact(ctx, artifactId, fileName)],
      });
      if (response.state !== 'SUCCEEDED') {
        throw new LcCheckerError('PORT_MISCONFIGURED', 'The inspection provider returned state ' + response.state, true);
      }
      const content = response.result?.content ?? JSON.stringify(response.result?.data ?? null);
      return parseCompliancePayload(content);
    }
  );

  return { kind: 'completed', resultRef: encodeInline(payload) };
};

function buildPorts(ctx: TaskContext): LcCheckerPorts {
  return {
    ocrFile: async () => {
      throw new LcCheckerError('PORT_MISCONFIGURED', 'ocrFile is only reachable through a spawned OCR child');
    },
    screen: async ({ ocrTexts, fileNames, ruleSetVersion }) => {
      const ocrMap = new Map<string, string>();
      for (const entry of ocrTexts) {
        if (entry.text.length > 0) ocrMap.set(entry.fileName, entry.text);
      }
      const response = await ctx.connector.invoke(CROSSCHECK_SLOT, {
        prompt: buildScreenPrompt({
          fileCount: fileNames.length,
          ocrTexts: ocrMap,
          fileNames,
          ruleSetVersion,
          maxVisualRequests: MAX_VISUAL_REQUESTS,
        }),
      });
      if (response.state !== 'SUCCEEDED') {
        throw new LcCheckerError('PORT_MISCONFIGURED', 'The screening provider returned state ' + response.state, true);
      }
      return parseCompliancePayload(response.result?.content ?? response.result?.data);
    },
    inspect: async () => {
      throw new LcCheckerError('PORT_MISCONFIGURED', 'inspect is only reachable through a spawned visual child');
    },
    adjudicate: async ({ ocrTexts, visualDigests, outstandingChecks, screenNotes, fileNames, ruleSetVersion }) => {
      const ocrMap = new Map<string, string>();
      for (const entry of ocrTexts) {
        if (entry.text.length > 0) ocrMap.set(entry.fileName, entry.text);
      }
      const response = await ctx.connector.invoke(CROSSCHECK_SLOT, {
        prompt: buildAdjudicationPrompt({
          fileCount: fileNames.length,
          ocrTexts: ocrMap,
          fileNames,
          visualDigests,
          screenNotes,
          outstandingChecks,
          ruleSetVersion,
        }),
      });
      if (response.state !== 'SUCCEEDED') {
        throw new LcCheckerError('PORT_MISCONFIGURED', 'The adjudication provider returned state ' + response.state, true);
      }
      return parseCompliancePayload(response.result?.content ?? response.result?.data);
    },
    generateReport: async ({ compliance }) => {
      const response = await ctx.connector.invoke(REPORT_SLOT, {
        prompt: buildReportPrompt({ compliance, fileCount: compliance.documentsPresent.length }),
      });
      if (response.state !== 'SUCCEEDED') {
        throw new LcCheckerError('PORT_MISCONFIGURED', 'The report provider returned state ' + response.state, true);
      }
      const content = response.result?.content ?? '';
      if (content.trim().length === 0) {
        throw new LcCheckerError('PORT_MISCONFIGURED', 'The report provider returned no text', true);
      }
      return content;
    },
  };
}

/** Root handler: drive the machine, persisting its state at every fan-out boundary. */
export const mainLcCheckerHandler: TaskHandler = async (ctx: TaskContext): Promise<TaskDisposition> => {
  assertActive(ctx);

  // The versioned ruleset workflow remains the canonical branch. Only the
  // exact legacy action marker enters the compatibility adapter, which uses
  // separately pinned providers and the frozen original three-stage flow.
  if (Object.hasOwn(ctx.input, 'legacyWorkflow')) return legacyLcCheckerHandler(ctx);

  const input = normalizeLcCheckerInput(ctx.input);
  const ruleSet = getRuleSet(input.ruleSetVersion);
  if (!ruleSet) {
    throw new LcCheckerError('RULESET_UNKNOWN', 'Unknown LC ruleset version ' + input.ruleSetVersion);
  }

  const state = await loadState(ctx);
  const requests = state?.screen?.visualRequests ?? [];
  const awaitingVisual = state?.pendingJoinToken === 'visual:' + input.inputVersion;
  const join = awaitingVisual
    ? buildVisualJoin(ctx, requests, input.fileNames, input.inputVersion)
    : ctx.input['joinSummary'] !== undefined
      ? buildOcrJoin(ctx, input.fileNames, input.inputVersion)
      : undefined;

  const step = await advanceLcChecker({ input, state, runtime: buildPorts(ctx), join });
  const spawn = step.continuation.kind === 'spawn-children' ? step.continuation : undefined;

  if (spawn) {
    const kind = spawn.stage === 'ocr' ? OCR_CHILD_KIND : VISUAL_CHILD_KIND;
    const prefix = spawn.stage === 'ocr' ? 'ocr-' : 'visual-';
    const specs: ChildTaskSpecInput[] = spawn.children.map((child, index) => ({
      taskKey: prefix + index,
      kind,
      payload: child.input as Record<string, unknown>,
    }));
    // Persisted BEFORE the children run: the pending join token is what lets the next
    // delivery know which round is coming back.
    await saveState(ctx, step.state);
    await ctx.progress.report(5, spawn.stage + ': ' + specs.length + ' task(s)');
    return ctx.spawn.spawnAndWait(specs, 'all-success', 'join:lc-checker:' + spawn.stage);
  }

  const done = step.continuation;
  if (done.kind !== 'terminate' || done.terminal !== 'SUCCEEDED' || !done.data) {
    throw new LcCheckerError('COMPLIANCE_INVALID', 'The examination ended without a usable result');
  }
  const result: LcCheckerResult = done.data;

  await ctx.progress.report(100, 'LC checking report ready');
  const serialized = JSON.stringify(result, null, 2);
  const artifact = await ctx.artifacts.write(serialized, 'lc-checker-result.json', 'application/json', 'output');

  return {
    kind: 'completed',
    resultRef: artifact.artifactId,
    artifacts: [
      { artifactId: artifact.artifactId, role: 'output', fileName: 'lc-checker-result.json', mimeType: 'application/json' },
    ],
  };
};

export const lcCheckerHandlers: Record<string, TaskHandler> = {
  'lc-checker': mainLcCheckerHandler,
  'lc-checker-ocr': ocrChildHandler,
  'lc-checker-visual': visualChildHandler,
  root: mainLcCheckerHandler,
};

export const lcCheckerBusiness: BusinessDefinition = defineBusiness(lcCheckerManifest, lcCheckerHandlers);

export interface LcCheckerWorkerConfig extends WorkerConfig {
  manifest?: typeof lcCheckerManifest;
}

export async function startLcCheckerWorker(config: LcCheckerWorkerConfig): Promise<WorkerHandle> {
  return startWorker(
    config.manifest ? defineBusiness(config.manifest, lcCheckerHandlers) : lcCheckerBusiness,
    config
  );
}
