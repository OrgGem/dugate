import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  CONNECTOR_ARTIFACT_MAX_BYTES,
  CONNECTOR_ARTIFACT_MAX_COUNT,
  LegacyWorkflowResultSchema,
  LegacyWorkflowSchemaPinSchema,
  LegacyWorkflowTaskInputSchema,
  canonicalLegacyWorkflowPinBytes,
  contentHash,
  parseLegacyWorkflowSchema,
  validateLegacyWorkflowEgressOrigins,
  validateLegacyWorkflowConnectorSlotMap,
  type InvocationArtifactContent,
  type InvocationResponse,
  type LegacyWorkflowNode,
  type LegacyWorkflowSchema,
  type LegacyWorkflowSchemaPin,
  type LegacyWorkflowTaskInput,
  type TaskDisposition,
} from '@du/contracts';
import type { TaskContext as SdkTaskContext } from '@du/worker-sdk';
import { createPinnedFetch } from '@du/egress';
import { DocumentFormatDetector, DocumentParserFactory, SafeArchiveExtractor } from '@du/document-kit';
import { applyPinnedStepPrompt } from '../../../actions/prompt-application';

const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_BRANCH_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_NODE_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_AGGREGATE_NODE_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_PARALLEL_BASE_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 512;
const MAX_CONNECTOR_SLOTS = 32;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_URL_DOWNLOADS = 20;
const MAX_CALLBACK_BODY_BYTES = 1024 * 1024;
const LEGACY_RESULT_VERSION = 'legacy-workflow-result-v1' as const;
const BRANCH_RESULT_VERSION = 'legacy-workflow-branch-result-v1' as const;
const BRANCH_MARKER = '__legacyWorkflowBranch';
const CONTINUATION_PREFIX = 'legacy-workflow:v1';

export interface LegacyWorkflowFileRef {
  readonly artifactId: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly role?: string;
}

export interface LegacyWorkflowNodeResult {
  readonly nodeId: string;
  readonly type: LegacyWorkflowNode['type'];
  readonly content?: string;
  readonly extractedData?: unknown;
  readonly files?: readonly LegacyWorkflowFileRef[];
  readonly data?: Record<string, unknown>;
  readonly output?: unknown;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly pages?: number;
    readonly costMicrousd: number;
  };
  /** The answered wait that produced this checkpoint; used only for replay fencing. */
  readonly waitId?: string;
}

interface LegacyBranchInput {
  readonly parallelNodeId: string;
  readonly branchIndex: number;
  readonly nodes: readonly LegacyWorkflowNode[];
  readonly baseResults: Record<string, LegacyWorkflowNodeResult>;
}

interface LegacyExecutionPayload {
  readonly input: LegacyWorkflowTaskInput;
  readonly legacyWorkflowSchema: LegacyWorkflowSchemaPin;
  readonly [BRANCH_MARKER]?: LegacyBranchInput;
}

interface LegacyExecutionState {
  readonly pin: LegacyWorkflowSchemaPin;
  readonly payload: LegacyExecutionPayload;
}

interface JoinState {
  readonly continuationRef: string;
  readonly joinSummary: Record<string, string | null>;
}

interface ParallelCheckpoint {
  readonly resultRefs: Record<string, string>;
  readonly terminalNodeIds: readonly string[];
}

interface ConnectorUsage {
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costUsd: number;
  hasPages: boolean;
  hasCost: boolean;
}

export class LegacyWorkflowRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LegacyWorkflowRuntimeError';
  }
}

/** Execute one admitted immutable schema using SDK checkpoints, children and HITL waits. */
export async function handleLegacyWorkflowSchema(
  context: SdkTaskContext,
  payload?: Record<string, unknown>,
): Promise<TaskDisposition> {
  return executeLegacyWorkflow(context, payload ?? context.input, 'root');
}

/** Child handler for one parallel branch; each branch yields its own queue slot. */
export async function handleLegacyWorkflowBranch(
  context: SdkTaskContext,
  payload?: Record<string, unknown>,
): Promise<TaskDisposition> {
  return executeLegacyWorkflow(context, payload ?? context.input, 'branch');
}

async function executeLegacyWorkflow(
  context: SdkTaskContext,
  raw: Record<string, unknown>,
  expectedTaskKind: 'root' | 'branch',
): Promise<TaskDisposition> {
  const state = await restoreOrPinExecution(context, raw);
  if (Object.hasOwn(raw, 'resumeInput') && typeof raw.waitId !== 'string' && context.waitResponse === undefined) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_WAIT_INVALID', 'Workflow resume is missing its wait identity.');
  }
  const branch = state.payload[BRANCH_MARKER];
  if ((expectedTaskKind === 'branch') !== (branch !== undefined)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_TASK_KIND_INVALID', 'Workflow branch task payload is invalid.');
  }
  const results: Record<string, LegacyWorkflowNodeResult> = branch ? { ...branch.baseResults } : {};
  let resume = joinStateFromRaw(raw, state.pin.digest);
  const resumedWaitId = typeof raw.waitId === 'string' ? raw.waitId : undefined;
  let resumedWaitConsumed = Object.values(results).some((result) => result.waitId === resumedWaitId && resumedWaitId !== undefined);
  const sequence = branch?.nodes ?? orderTopLevel(state.pin.schema);
  const parallelNodeId = branch?.parallelNodeId;
  const parallelBranchIndex = branch?.branchIndex;

  for (let index = 0; index < sequence.length; index += 1) {
    assertActive(context);
    const node = sequence[index]!;
    if (expectedTaskKind === 'root') {
      await context.progress.report(
        Math.min(99, Math.round((index / Math.max(sequence.length, 1)) * 99)),
        `Legacy workflow step ${index + 1} of ${sequence.length}`,
      );
    }
    if (node.type === 'parallel') {
      const checkpointKey = nodeCheckpointKey(state.pin.digest, node.id, expectedTaskKind, parallelNodeId, parallelBranchIndex);
      const continuation = continuationRef(state.pin.digest, node.id);
      const inputHash = nodeInputHash(state, context, node, results);
      const existing = await context.step.peek(checkpointKey);
      if (existing?.status === 'SUCCEEDED') {
        const checkpoint = await context.step.run<ParallelCheckpoint>(checkpointKey, inputHash, async () => {
          throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CHECKPOINT_MISSING', 'Parallel workflow checkpoint is unavailable.');
        });
        await restoreParallelResults(context, state.pin.digest, node, checkpoint, results);
        assertAggregateResultBudget(results);
        // A redelivery can carry the join summary for this already-committed
        // parallel node. Consume it here; otherwise it would be mistaken for
        // an unrelated continuation at a later parallel node.
        if (resume?.continuationRef === continuation) resume = null;
        continue;
      }

      const joined = resume?.continuationRef === continuation ? resume.joinSummary : null;
      if (resume && !joined) {
        throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONTINUATION_INVALID', 'Workflow continuation does not match an uncheckpointed parallel node.');
      }
      if (joined) {
        const checkpoint: ParallelCheckpoint = {
          resultRefs: branchResultRefs(sequence, node, joined, results),
          terminalNodeIds: [],
        };
        const terminalNodeIds = await restoreParallelResults(context, state.pin.digest, node, checkpoint, results);
        const completed = await context.step.run<ParallelCheckpoint>(checkpointKey, inputHash, async () => ({
          resultRefs: checkpoint.resultRefs,
          terminalNodeIds,
        }));
        await restoreParallelResults(context, state.pin.digest, node, completed, results);
        assertAggregateResultBudget(results);
        resume = null;
        continue;
      }
      {
        assertParallelPayloadBudget(results, node.branches!.length);
        const children = node.branches!.map((nodes, branchIndex) => ({
          taskKey: branchTaskKey(node.id, branchIndex),
          kind: 'legacy-workflow-branch',
          payload: {
            input: state.payload.input,
            legacyWorkflowSchema: state.pin,
            [BRANCH_MARKER]: {
              parallelNodeId: node.id,
              branchIndex,
              nodes,
              baseResults: results,
            },
          },
        }));
        return context.spawn.spawnAndWait(
          children,
          'all-success',
          continuationRef(state.pin.digest, node.id),
        );
      }
    }

    const checkpointKey = nodeCheckpointKey(state.pin.digest, node.id, expectedTaskKind, parallelNodeId, parallelBranchIndex);
    const inputHash = nodeInputHash(state, context, node, results);
    if (node.type === 'human') {
      const existing = await context.step.peek(checkpointKey);
      if (existing?.status === 'SUCCEEDED') {
        const previous = await context.step.run<LegacyWorkflowNodeResult>(checkpointKey, inputHash, async () => {
          throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CHECKPOINT_MISSING', 'Human workflow checkpoint is unavailable.');
        });
        applyHumanResponse(results, previous.output);
        results[node.id] = previous;
        assertAggregateResultBudget(results);
        if (resumedWaitId !== undefined && previous.waitId === resumedWaitId) resumedWaitConsumed = true;
        continue;
      }

      const waitResponse = resumedWaitConsumed ? undefined : readWaitResponse(context, raw);
      if (waitResponse === undefined) {
        const waitDisposition = await context.wait.waitForInput(
          `legacy-workflow:${state.pin.digest}:${node.id}`,
          {
            type: 'object',
            properties: {
              step: { type: 'integer', minimum: 1, maximum: sequence.length },
              extracted_data: {},
            },
            additionalProperties: true,
          },
          { contextRef: `legacy-workflow:${state.pin.digest}:${node.id}` },
        );
        return waitDisposition;
      }
      applyHumanResponse(results, waitResponse);
      const completed = await context.step.run<LegacyWorkflowNodeResult>(checkpointKey, inputHash, async () => ({
        nodeId: node.id,
        type: 'human',
        data: { message: node.message, resumeInputs: node.resumeInputs ?? [] },
        output: waitResponse,
        extractedData: isRecord(waitResponse) && Object.hasOwn(waitResponse, 'extracted_data')
          ? waitResponse.extracted_data
          : undefined,
        ...(resumedWaitId !== undefined ? { waitId: resumedWaitId } : {}),
      }));
      results[node.id] = completed;
      assertAggregateResultBudget(results);
      resumedWaitConsumed = true;
      continue;
    }

    if (node.type === 'input') {
      results[node.id] = await context.step.run<LegacyWorkflowNodeResult>(checkpointKey, inputHash, async () => ({
        nodeId: node.id,
        type: 'input',
        data: { key: node.key },
        output: ownPath(state.payload.input.variables, String(node.key)),
      }));
      assertAggregateResultBudget(results);
      continue;
    }

    if (node.type === 'join') {
      const sources = Object.keys(results).filter((id) => id !== node.id && results[id]?.output !== undefined);
      const outputs = sources.map((id) => results[id]!.output);
      results[node.id] = await context.step.run<LegacyWorkflowNodeResult>(checkpointKey, inputHash, async () => ({
        nodeId: node.id,
        type: 'join',
        data: { sources },
        output: combineJoinOutputs(node.combine, outputs),
      }));
      assertAggregateResultBudget(results);
      continue;
    }

    if (node.type === 'connector' || node.type === 'file_parse' || node.type === 'file_url_download'
        || node.type === 'callback' || node.type === 'archive_compress' || node.type === 'archive_extract') {
      const nodeResult = await context.step.run(checkpointKey, inputHash, async () => {
        const resolved = resolveNodeBindings(node, state.payload.input, results);
        const result = await executeLeaf(context, state.pin, state.payload.input, node, resolved, results, checkpointKey);
        assertSingleNodeResultBudget(result);
        return result;
      });
      results[node.id] = nodeResult;
      assertAggregateResultBudget(results);
      continue;
    }
  }

  if (expectedTaskKind === 'branch') {
    if (!parallelNodeId || parallelBranchIndex === undefined) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_BRANCH_INVALID', 'Workflow branch identity is missing.');
    }
    const terminalNodeId = sequence[sequence.length - 1]?.id ?? null;
    const branchResult = {
      schemaVersion: BRANCH_RESULT_VERSION,
      digest: state.pin.digest,
      parallelNodeId,
      branchIndex: parallelBranchIndex,
      terminalNodeId,
      usage: aggregateUsage(results),
      nodeResults: results,
    };
    const bytes = Buffer.from(JSON.stringify(branchResult), 'utf8');
    if (bytes.byteLength > MAX_BRANCH_RESULT_BYTES) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_RESULT_TOO_LARGE', 'Workflow branch result exceeds the supported limit.');
    }
    // Child resultRefs are validated as declared outputs by worker-sdk. Keep
    // this encrypted branch checkpoint output-scoped so the durable child
    // result can be joined by the parent task.
    const ref = await context.artifacts.write(bytes, 'legacy-workflow-branch.json', 'application/json', 'output');
    return { kind: 'completed', resultRef: `artifact://${ref.artifactId}` };
  }

  const final = buildLegacyResult(state.pin.schema, sequence, results, aggregateUsage(results));
  const bytes = Buffer.from(JSON.stringify(final), 'utf8');
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_RESULT_TOO_LARGE', 'Workflow result exceeds the supported limit.');
  }
  const checked = LegacyWorkflowResultSchema.safeParse(final);
  if (!checked.success) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_RESULT_INVALID', 'Workflow result failed contract validation.');
  }
  await context.progress.report(100, 'Legacy workflow complete');
  return { kind: 'completed', resultRef: bytes.toString('utf8') };
}

async function restoreOrPinExecution(
  context: SdkTaskContext,
  raw: Record<string, unknown>,
): Promise<LegacyExecutionState> {
  const payloadCheckpoint = payloadCheckpointKey(context.taskKey);
  const payloadHash = contentHash({ tenantId: context.tenantId, taskKey: context.taskKey, version: 'legacy-workflow-payload-v1' });
  const existing = await context.step.peek(payloadCheckpoint);
  let rawPayload: unknown;
  if (existing?.status === 'SUCCEEDED') {
    rawPayload = await context.step.run(payloadCheckpoint, payloadHash, async () => {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_SNAPSHOT_MISSING', 'Pinned workflow snapshot is unavailable.');
    });
  } else {
    rawPayload = raw;
  }
  if (!isRecord(rawPayload)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_INPUT_INVALID', 'Workflow task payload is invalid.');
  }
  if (!isRecord(rawPayload.legacyWorkflowSchema) || !Object.hasOwn(rawPayload, 'input')) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_SNAPSHOT_MISSING', 'Admitted workflow snapshot is unavailable for this task delivery.');
  }
  const pinParsed = LegacyWorkflowSchemaPinSchema.safeParse(rawPayload.legacyWorkflowSchema);
  if (!pinParsed.success) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PIN_INVALID', 'Admitted workflow schema pin is invalid.');
  }
  const pin = pinParsed.data;
  let validatedSchema: LegacyWorkflowSchema;
  try {
    validatedSchema = parseLegacyWorkflowSchema(pin.schema);
  } catch {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PIN_INVALID', 'Admitted workflow schema failed validation.');
  }
  if (pin.tenantId !== context.tenantId || pin.slug !== pin.schema.slug) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PIN_INVALID', 'Admitted workflow schema tenant or slug is invalid.');
  }
  let connectorSlotMap: Record<string, string>;
  try {
    connectorSlotMap = validateLegacyWorkflowConnectorSlotMap(validatedSchema, pin.connectorSlotMap ?? {});
  } catch {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PIN_INVALID', 'Admitted workflow connector mapping is invalid.');
  }
  let approvedEgressOrigins: string[];
  try {
    approvedEgressOrigins = validateLegacyWorkflowEgressOrigins(validatedSchema, pin.approvedEgressOrigins ?? []);
  } catch {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PIN_INVALID', 'Admitted workflow egress policy is invalid.');
  }
  const digest = `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(validatedSchema, connectorSlotMap, approvedEgressOrigins)).digest('hex')}`;
  if (digest !== pin.digest) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PIN_INVALID', 'Admitted workflow schema digest does not match.');
  }
  if (Object.keys(connectorSlotMap).length > MAX_CONNECTOR_SLOTS) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PIN_INVALID', 'Admitted workflow connector mapping exceeds the supported limit.');
  }
  const taskInput = LegacyWorkflowTaskInputSchema.safeParse(rawPayload.input);
  if (!taskInput.success) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_INPUT_INVALID', 'Workflow input failed contract validation.');
  }
  const normalized: LegacyExecutionPayload = {
    input: applyInputDefaults(validatedSchema, taskInput.data),
    legacyWorkflowSchema: { ...pin, schema: validatedSchema, connectorSlotMap, approvedEgressOrigins },
    ...(isRecord(rawPayload[BRANCH_MARKER]) ? { [BRANCH_MARKER]: parseBranchInput(rawPayload[BRANCH_MARKER]) } : {}),
  };
  if (existing?.status !== 'SUCCEEDED') {
    if (!Object.hasOwn(raw, 'legacyWorkflowSchema') || !Object.hasOwn(raw, 'input')) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_SNAPSHOT_MISSING', 'Admitted workflow snapshot is unavailable for this task delivery.');
    }
    rawPayload = await context.step.run(payloadCheckpoint, payloadHash, async () => normalized);
  } else {
    const join = joinStateFromRaw(raw, undefined, true);
    if (join && digestFromContinuation(join.continuationRef) !== pin.digest) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONTINUATION_INVALID', 'Workflow continuation digest does not match the admitted schema.');
    }
    if (isRecord(raw.legacyWorkflowSchema) && Object.hasOwn(raw, 'input')) {
      const incomingPin = LegacyWorkflowSchemaPinSchema.safeParse(raw.legacyWorkflowSchema);
      if (!incomingPin.success || incomingPin.data.digest !== pin.digest) {
        throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PIN_INVALID', 'Redelivered workflow schema differs from the admitted pin.');
      }
    }
  }
  const checkpointPayload = rawPayload as LegacyExecutionPayload;
  return { pin, payload: checkpointPayload };
}

function parseBranchInput(value: Record<string, unknown>): LegacyBranchInput {
  if (typeof value.parallelNodeId !== 'string' || !Number.isSafeInteger(value.branchIndex)
      || !Array.isArray(value.nodes) || !isRecord(value.baseResults)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_BRANCH_INVALID', 'Workflow branch task payload is invalid.');
  }
  return {
    parallelNodeId: value.parallelNodeId,
    branchIndex: Number(value.branchIndex),
    nodes: value.nodes as LegacyWorkflowNode[],
    baseResults: value.baseResults as Record<string, LegacyWorkflowNodeResult>,
  };
}

function applyInputDefaults(schema: LegacyWorkflowSchema, input: LegacyWorkflowTaskInput): LegacyWorkflowTaskInput {
  const variables: Record<string, unknown> = { ...input.variables };
  for (const [key, property] of Object.entries(schema.input_schema?.properties ?? {})) {
    if (!Object.hasOwn(variables, key) && Object.hasOwn(property, 'default')) variables[key] = property.default;
    if (property.required === true && !Object.hasOwn(variables, key)) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_INPUT_REQUIRED', `Workflow input is missing required field "${key}".`);
    }
    const value = variables[key];
    if (value !== undefined && !matchesInputType(value, property.type)) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_INPUT_INVALID', `Workflow input field "${key}" has an invalid type.`);
    }
  }
  return { ...input, variables };
}

function matchesInputType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'object': return isRecord(value);
    default: return false;
  }
}

function orderTopLevel(schema: LegacyWorkflowSchema): LegacyWorkflowNode[] {
  const byId = new Map(schema.nodes.map((node) => [node.id, node]));
  return schema.flow.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * WFA 6d: `join.combine` semantics (legacy docs/workflow-schema-guide.md §3.3):
 *   - 'first' → the first branch output;
 *   - 'merge' → shallow-merge OBJECT outputs into one object (documented
 *     "merge object (nếu là object)"); when any output is not a plain object
 *     the array is kept so no output is dropped;
 *   - 'concat' or absent → the array of every output (the legacy default).
 * A merge conflict is resolved like an object spread: later sources win.
 */
function combineJoinOutputs(combine: unknown, outputs: readonly unknown[]): unknown {
  if (combine === 'first') return outputs[0];
  if (combine === 'merge' && outputs.length > 0 && outputs.every((output) => isRecord(output))) {
    return Object.assign({}, ...outputs);
  }
  return outputs;
}

function nodeInputHash(
  state: LegacyExecutionState,
  context: SdkTaskContext,
  node: LegacyWorkflowNode,
  results: Record<string, LegacyWorkflowNodeResult>,
): string {
  return contentHash({
    digest: state.pin.digest,
    taskKey: context.taskKey,
    node,
    variables: state.payload.input.variables,
    artifactIds: state.payload.input.artifactIds,
    fileNames: state.payload.input.fileNames,
    results,
  });
}

function branchResultRefs(
  sequence: readonly LegacyWorkflowNode[],
  node: LegacyWorkflowNode,
  joinSummary: Record<string, string | null>,
  completedResults: Record<string, LegacyWorkflowNodeResult>,
): Record<string, string> {
  if (node.type !== 'parallel' || !Array.isArray(node.branches)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Parallel node definition is invalid.');
  }
  const refs: Record<string, string> = {};
  for (let index = 0; index < node.branches.length; index += 1) {
    const key = branchTaskKey(node.id, index);
    const ref = joinSummary[key];
    if (typeof ref !== 'string') {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow branch result is missing.');
    }
    refs[key] = ref;
  }
  // Runtime parent joins aggregate every child ever spawned by this parent task,
  // not just the latest spawn. Earlier, already-checkpointed parallel nodes are
  // therefore present in a later join summary. Accept those exact immutable
  // schema keys only after their parent parallel result has been restored; an
  // arbitrary sibling key is still an integrity failure.
  const currentIndex = sequence.findIndex((candidate) => candidate.id === node.id);
  const previouslyCompletedBranchKeys = new Set<string>();
  for (const previous of sequence.slice(0, Math.max(currentIndex, 0))) {
    if (previous.type !== 'parallel' || !Array.isArray(previous.branches)) continue;
    if (completedResults[previous.id]?.type !== 'parallel') continue;
    for (let index = 0; index < previous.branches.length; index += 1) {
      previouslyCompletedBranchKeys.add(branchTaskKey(previous.id, index));
    }
  }
  if (Object.keys(joinSummary).some((key) => !Object.hasOwn(refs, key) && !previouslyCompletedBranchKeys.has(key))) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow join contains an unknown branch result.');
  }
  return refs;
}

async function restoreParallelResults(
  context: SdkTaskContext,
  digest: string,
  node: LegacyWorkflowNode,
  checkpoint: ParallelCheckpoint,
  results: Record<string, LegacyWorkflowNodeResult>,
): Promise<string[]> {
  if (node.type !== 'parallel' || !Array.isArray(node.branches)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Parallel node definition is invalid.');
  }
  const terminalNodeIds: string[] = [];
  for (let branchIndex = 0; branchIndex < node.branches.length; branchIndex += 1) {
    const ref = checkpoint.resultRefs[branchTaskKey(node.id, branchIndex)];
    if (typeof ref !== 'string') {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow branch checkpoint is missing.');
    }
    const branchResult = await readBranchResult(context, ref, digest, node.id, branchIndex);
    for (const [id, result] of Object.entries(branchResult.nodeResults)) results[id] = result;
    if (branchResult.terminalNodeId) terminalNodeIds.push(branchResult.terminalNodeId);
  }
  assertAggregateResultBudget(results);
  if (checkpoint.terminalNodeIds.length > 0 && JSON.stringify(checkpoint.terminalNodeIds) !== JSON.stringify(terminalNodeIds)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow branch terminals changed after join.');
  }
  results[node.id] = {
    nodeId: node.id,
    type: 'parallel',
    data: { branches: terminalNodeIds },
    output: terminalNodeIds,
  };
  return terminalNodeIds;
}

function joinStateFromRaw(raw: Record<string, unknown>, digest: string | undefined, recover = false): JoinState | null {
  const continuationRef = raw.continuationRef;
  if (typeof continuationRef !== 'string' || !continuationRef.startsWith(`${CONTINUATION_PREFIX}:`)) return null;
  if (digest !== undefined && digestFromContinuation(continuationRef) !== digest) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONTINUATION_INVALID', 'Workflow continuation digest does not match.');
  }
  if (recover) return { continuationRef, joinSummary: {} };
  if (!isRecord(raw.joinSummary)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow continuation results are missing.');
  }
  const joinSummary: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw.joinSummary)) {
    if (typeof value !== 'string' && value !== null) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow continuation result is malformed.');
    }
    joinSummary[key] = value;
  }
  return { continuationRef, joinSummary };
}

function digestFromContinuation(value: string): string {
  const match = /^legacy-workflow:v1:(sha256:[a-f0-9]{64}):[A-Za-z_][A-Za-z0-9_]{0,63}$/.exec(value);
  if (!match) throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONTINUATION_INVALID', 'Workflow continuation reference is malformed.');
  return match[1]!;
}

function continuationRef(digest: string, nodeId: string): string {
  return `${CONTINUATION_PREFIX}:${digest}:${nodeId}`;
}

function payloadCheckpointKey(taskKey: string): string {
  const taskHash = createHash('sha256').update(taskKey).digest('hex').slice(0, 32);
  return `legacy-workflow:payload:${taskHash}`;
}

function branchTaskKey(nodeId: string, branchIndex: number): string {
  return `legacy-workflow:${nodeId}:branch:${String(branchIndex).padStart(2, '0')}`;
}

function nodeCheckpointKey(
  digest: string,
  nodeId: string,
  taskKind: string,
  parallelNodeId?: string,
  branchIndex?: number,
): string {
  const branch = parallelNodeId === undefined ? 'root' : `${parallelNodeId}-${branchIndex ?? 0}`;
  return `legacy-workflow:node:${digest}:${taskKind}:${branch}:${nodeId}`;
}

function readWaitResponse(context: SdkTaskContext, raw: Record<string, unknown>): unknown | undefined {
  if (context.waitResponse !== undefined) return context.waitResponse;
  if (Object.hasOwn(raw, 'resumeInput') && typeof raw.waitId === 'string') return raw.resumeInput;
  if (Object.hasOwn(context.input, 'resumeInput') && typeof context.input.waitId === 'string') return context.input.resumeInput;
  return undefined;
}

function applyHumanResponse(results: Record<string, LegacyWorkflowNodeResult>, response: unknown): void {
  if (!isRecord(response) || typeof response.step !== 'number' || !Object.hasOwn(response, 'extracted_data')) return;
  const entry = Object.values(results).find((result, index) => index + 1 === response.step);
  if (!entry) return;
  results[entry.nodeId] = { ...entry, extractedData: response.extracted_data, output: response.extracted_data };
}

function resolveNodeBindings(
  node: LegacyWorkflowNode,
  input: LegacyWorkflowTaskInput,
  results: Record<string, LegacyWorkflowNodeResult>,
): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    ...input.variables,
  };
  const resolve = (binding: unknown): unknown => resolveBinding(binding, variables, results, input);
  const resolved: Record<string, unknown> = {};
  if (node.type === 'connector') {
    const inputs = node.inputs;
    if (isRecord(inputs)) for (const [key, value] of Object.entries(inputs)) resolved[key] = resolve(value);
  } else if (node.type === 'file_parse' || node.type === 'archive_compress' || node.type === 'archive_extract') {
    resolved.source = resolve(node.source);
  } else if (node.type === 'file_url_download') {
    resolved.urls = resolve(node.urls);
  } else if (node.type === 'callback') {
    resolved.url = resolve(node.url);
    resolved.payload = resolve(node.payload);
  }
  return resolved;
}

function resolveBinding(
  binding: unknown,
  variables: Record<string, unknown>,
  results: Record<string, LegacyWorkflowNodeResult>,
  input: LegacyWorkflowTaskInput,
): unknown {
  if (typeof binding !== 'string') return binding;
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\.(.+))?$/.exec(binding);
  if (!match) return binding;
  const [, root, path] = match;
  if (root === 'input') return path ? ownPath(variables, path) : variables;
  if (root === 'file') return buildFileRefs(input)[0] ?? null;
  if (root === 'files') return buildFileRefs(input);
  const result = results[root!];
  if (!result) return undefined;
  if (!path) return result.output ?? result.data ?? result.content;
  const [head, ...tail] = path.split('.');
  const ownValue = Object.hasOwn(result, head!) ? result[head as keyof LegacyWorkflowNodeResult] : undefined;
  const rootValue = ownValue !== undefined && !(head === 'data' && isRecord(ownValue) && Object.keys(ownValue).length === 0)
    ? ownValue
    : result.output ?? result.data ?? result.content;
  return tail.length > 0 ? ownPath(rootValue, tail.join('.')) : rootValue;
}

function ownPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split('.')) {
    if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') return undefined;
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function buildFileRefs(input: LegacyWorkflowTaskInput): LegacyWorkflowFileRef[] {
  const roles = new Map(input.artifacts.map((item) => [item.artifactId, item.role]));
  return input.artifactIds.map((artifactId, index) => ({
    artifactId,
    fileName: input.fileNames[index] ?? `document-${index + 1}`,
    role: roles.get(artifactId),
  }));
}

async function executeLeaf(
  context: SdkTaskContext,
  pin: LegacyWorkflowSchemaPin,
  workflowInput: LegacyWorkflowTaskInput,
  node: LegacyWorkflowNode,
  resolved: Record<string, unknown>,
  results: Record<string, LegacyWorkflowNodeResult>,
  stepKey: string,
): Promise<LegacyWorkflowNodeResult> {
  const nodeRecord = node as Record<string, unknown>;
  const permitted = permittedArtifactRefs(workflowInput, results);
  switch (node.type) {
    case 'connector':
      return executeConnectorNode(context, pin, node, nodeRecord, resolved, permitted, stepKey);
    case 'file_parse':
      return executeFileParseNode(context, node, nodeRecord, resolved.source, permitted);
    case 'file_url_download':
      return executeFileUrlDownloadNode(context, pin, node, nodeRecord, resolved.urls);
    case 'callback':
      return executeCallbackNode(context, pin, node, nodeRecord, resolved, results);
    case 'archive_compress':
      return executeArchiveCompressNode(context, node, nodeRecord, resolved.source, permitted);
    case 'archive_extract':
      return executeArchiveExtractNode(context, node, nodeRecord, resolved.source, permitted);
    default:
      throw new LegacyWorkflowRuntimeError(
        'LEGACY_WORKFLOW_NODE_INVALID',
        `Legacy workflow node type "${node.type}" cannot be executed as a leaf.`,
      );
  }
}

async function executeConnectorNode(
  context: SdkTaskContext,
  pin: LegacyWorkflowSchemaPin,
  node: LegacyWorkflowNode,
  nodeRecord: Record<string, unknown>,
  resolved: Record<string, unknown>,
  permitted: ReadonlyMap<string, LegacyWorkflowFileRef>,
  stepKey: string,
): Promise<LegacyWorkflowNodeResult> {
  const connectorName = stringField(nodeRecord, 'connector');
  const slot = connectorName ? ownPath(pin.connectorSlotMap ?? {}, connectorName) : undefined;
  if (typeof slot !== 'string' || !Object.hasOwn(pin.connectorSlotMap ?? {}, connectorName ?? '')) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_UNMAPPED', 'Workflow connector has no admitted profile slot.');
  }
  if (!Object.hasOwn(context.connectorBindings, slot) || !context.connectorBindings[slot]) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_UNBOUND', 'Workflow connector slot is not bound by the admitted profile.');
  }

  const override = isRecord(nodeRecord.overrideConnector) ? nodeRecord.overrideConnector : {};
  if (typeof override.extraHeaders === 'string' && override.extraHeaders.length > 0) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_OVERRIDE_UNSUPPORTED', 'Workflow connector extraHeaders require an approved connector revision.');
  }
  if (typeof override.staticFormFields === 'string' && override.staticFormFields.length > 0) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_OVERRIDE_UNSUPPORTED', 'Workflow connector staticFormFields require an approved connector revision.');
  }

  const inputs = isRecord(nodeRecord.inputs) ? resolved : {};
  const inputPrompt = typeof inputs.prompt === 'string' ? inputs.prompt : '';
  const promptValues = Object.fromEntries(Object.entries(inputs).filter(([key]) => key !== 'prompt'));
  const contextText = Object.keys(promptValues).length > 0 ? JSON.stringify(promptValues) : '';
  const defaultPrompt = inputPrompt || (contextText ? `Process the supplied workflow inputs:\n${contextText}` : `Execute workflow connector step ${node.id}.`);
  const codePrompt = typeof override.prompt === 'string' ? override.prompt : undefined;
  const prompt = applyPinnedStepPrompt(context, {
    slot,
    stepId: stringField(nodeRecord, 'promptOverrideKey') ?? node.id,
    defaultText: defaultPrompt,
    codePrompt,
  });

  const fileRefs = collectFileRefs(resolved, permitted);
  if (fileRefs.length > CONNECTOR_ARTIFACT_MAX_COUNT) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_FILES_LIMIT', 'Workflow connector binds more files than the connector allows.');
  }
  const artifacts = await readConnectorArtifacts(context, fileRefs);
  const invokeInput = {
    task: node.id,
    prompt,
    ...(contextText ? { text: contextText } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
  const options = { responseFormat: typeof nodeRecord.outputPath === 'string' || typeof override.responseContentPath === 'string' ? 'json' : 'text' };
  const timeoutSec = typeof override.timeoutSec === 'number' ? override.timeoutSec : undefined;
  const deadlineAt = timeoutSec === undefined
    ? undefined
    : await stableConnectorDeadline(context, stepKey, timeoutSec);

  let response: InvocationResponse;
  try {
    response = await context.connector.invoke(slot, invokeInput, options, deadlineAt ? { deadlineAt } : undefined);
  } catch (error: unknown) {
    const wrapped = new LegacyWorkflowRuntimeError(
      'LEGACY_WORKFLOW_CONNECTOR_FAILED',
      'Workflow connector invocation failed.',
    ) as LegacyWorkflowRuntimeError & { retryable?: boolean; retryAfterMs?: number };
    // A connector 409 INVOCATION_UNKNOWN is the ledger refusing a replay while
    // the original dispatch is still in flight; it is a settle-and-retry, never
    // a terminal failure. Without carrying the classification through this
    // wrap the runtime would terminal-fail the task instead of coming back to
    // read the stored result.
    if ((error as { code?: unknown }).code === 'INVOCATION_UNKNOWN') {
      wrapped.retryable = true;
      wrapped.retryAfterMs = 5_000;
    }
    throw wrapped;
  }
  if (response.state !== 'SUCCEEDED' || !response.result) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_FAILED', 'Workflow connector did not return a completed result.');
  }

  const responseData = response.result.data;
  let content = response.result.content;
  let extractedData = responseData;
  let output: unknown = responseData !== undefined ? responseData : content;
  const responseContentPath = stringField(override, 'responseContentPath');
  if (responseContentPath) {
    const pathRoot = recordOrParsedJson(responseData, content);
    const selected = ownPath(pathRoot, responseContentPath);
    if (selected === undefined) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_OUTPUT_INVALID', 'Workflow connector responseContentPath did not resolve.');
    }
    content = typeof selected === 'string' ? selected : JSON.stringify(selected);
    output = selected;
  }
  const outputPath = stringField(nodeRecord, 'outputPath');
  if (outputPath) {
    const selected = ownPath({ content, extractedData, data: responseData, result: { content, data: responseData } }, outputPath);
    if (selected === undefined) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_OUTPUT_INVALID', 'Workflow connector outputPath did not resolve.');
    }
    output = selected;
  }
  if (content !== undefined && content !== null && typeof content !== 'string') content = JSON.stringify(content);

  const usage = response.usage ? {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    ...(response.usage.pages !== undefined ? { pages: response.usage.pages } : {}),
    costMicrousd: response.usage.costMicrousd,
  } : undefined;
  return {
    nodeId: node.id,
    type: node.type,
    ...(typeof content === 'string' ? { content } : {}),
    ...(extractedData !== undefined ? { extractedData } : {}),
    // The provider data is output evidence. Inputs, prompts, credentials and headers
    // are deliberately absent from checkpoint-visible node metadata.
    data: { processor: connectorName },
    ...(output !== undefined ? { output } : {}),
    ...(usage ? { usage } : {}),
  };
}

async function executeFileParseNode(
  context: SdkTaskContext,
  node: LegacyWorkflowNode,
  nodeRecord: Record<string, unknown>,
  source: unknown,
  permitted: ReadonlyMap<string, LegacyWorkflowFileRef>,
): Promise<LegacyWorkflowNodeResult> {
  const refs = collectFileRefs(source, permitted);
  if (refs.length === 0) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_PARSE_SOURCE_INVALID', 'Workflow file_parse source contains no authorized files.');
  }
  if (refs.length > 64) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_LIMIT', 'Workflow file_parse source exceeds the supported file count.');
  }
  const parserName = stringField(nodeRecord, 'parser') ?? 'auto';
  const parserFactory = new DocumentParserFactory();
  const parsed: Record<string, unknown>[] = [];
  for (const ref of refs) {
    const artifact = await context.artifacts.readWithMetadata(ref.artifactId, { signal: context.signal });
    if (artifact.buffer.byteLength > MAX_ARTIFACT_BYTES) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_TOO_LARGE', 'Workflow file_parse source exceeds the worker file limit.');
    }
    const format = DocumentFormatDetector.detect(artifact.buffer, ref.fileName, artifact.mimeType).format;
    if (!parserMatches(parserName, format)) {
      parsed.push({ file: ref.fileName, status: 'no_parser' });
      continue;
    }
    try {
      const result = await parserFactory.parseBuffer(
        artifact.buffer,
        ref.fileName,
        artifact.mimeType,
        { maxBufferSizeBytes: MAX_ARTIFACT_BYTES, timeoutMs: 30_000 },
      );
      parsed.push({ file: ref.fileName, status: 'success', text: result.text, markdown: result.markdown });
    } catch {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_PARSE_FAILED', 'Workflow file_parse could not parse an authorized source file.');
    }
  }
  const output = parsed;
  const content = parsed.map((item) => typeof item.text === 'string' ? item.text : JSON.stringify(item)).join('\n');
  return { nodeId: node.id, type: node.type, content, data: { parsed }, output, extractedData: output };
}

async function executeFileUrlDownloadNode(
  context: SdkTaskContext,
  pin: LegacyWorkflowSchemaPin,
  node: LegacyWorkflowNode,
  nodeRecord: Record<string, unknown>,
  resolvedUrls: unknown,
): Promise<LegacyWorkflowNodeResult> {
  const entries = normalizeUrlEntries(resolvedUrls, node.id);
  if (entries.length > MAX_URL_DOWNLOADS) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_URL_LIMIT', 'Workflow file URL count exceeds the supported limit.');
  }
  const auth = normalizeUrlAuth(nodeRecord.auth, true);
  const allowedExtensions = stringField(nodeRecord, 'allowedExtensions');
  const downloaded: LegacyWorkflowFileRef[] = [];
  for (const [index, entry] of entries.entries()) {
    assertActive(context);
    const approvedUrl = requireApprovedHttpsOrigin(pin, entry.url, 'file_url_download');
    const url = applyQueryAuth(approvedUrl, auth);
    const controller = makeBoundedAbortController(context, 30_000);
    try {
      const response = await createPinnedFetch({ timeoutMs: 15_000 })(url, {
        method: 'GET',
        headers: authHeaders(auth),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED', 'Workflow file URL download returned an unsuccessful status.');
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_ARTIFACT_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_TOO_LARGE', 'Workflow file URL response exceeds the worker file limit.');
      }
      const bytes = await readBoundedResponse(response, MAX_ARTIFACT_BYTES);
      if (bytes.byteLength === 0) {
        throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED', 'Workflow file URL returned an empty response.');
      }
      const fileName = chooseDownloadedName(entry.fileName, response.headers.get('content-disposition'), url, index);
      assertAllowedExtension(fileName, allowedExtensions);
      const mimeType = normalizeMimeType(response.headers.get('content-type')?.split(';')[0] ?? entry.mimeType ?? 'application/octet-stream');
      const artifact = await context.artifacts.write(bytes, fileName, mimeType, 'intermediate');
      downloaded.push({ artifactId: artifact.artifactId, fileName, mimeType, role: 'intermediate' });
    } catch (error) {
      if (error instanceof LegacyWorkflowRuntimeError) throw error;
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED', 'Workflow file URL destination or response was denied.');
    } finally {
      controller.dispose();
    }
  }
  return {
    nodeId: node.id,
    type: node.type,
    files: downloaded,
    data: { downloaded: downloaded.map(({ artifactId, fileName, mimeType }) => ({ artifactId, fileName, mimeType })) },
    output: downloaded,
  };
}

async function executeCallbackNode(
  context: SdkTaskContext,
  pin: LegacyWorkflowSchemaPin,
  node: LegacyWorkflowNode,
  nodeRecord: Record<string, unknown>,
  resolved: Record<string, unknown>,
  results: Record<string, LegacyWorkflowNodeResult>,
): Promise<LegacyWorkflowNodeResult> {
  if (typeof resolved.url !== 'string') {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CALLBACK_INVALID', 'Workflow callback destination is invalid.');
  }
  const url = requireApprovedHttpsOrigin(pin, resolved.url, 'callback');
  const method = stringField(nodeRecord, 'method') ?? 'POST';
  const auth = normalizeUrlAuth(nodeRecord.auth, false);
  const headers = authHeaders(auth);
  headers['content-type'] = 'application/json';
  const payload = resolved.payload === undefined ? lastNodeOutput(results) : resolved.payload;
  const body = payload === undefined ? undefined : typeof payload === 'string' ? payload : safeJson(payload);
  if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_CALLBACK_BODY_BYTES) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CALLBACK_TOO_LARGE', 'Workflow callback body exceeds the supported limit.');
  }
  const requestUrl = method === 'GET' && auth.type === 'query' ? applyQueryAuth(url, auth) : url;
  const controller = makeBoundedAbortController(context, 30_000);
  try {
    const response = await createPinnedFetch({ timeoutMs: 15_000 })(requestUrl, {
      method,
      headers,
      signal: controller.signal,
      redirect: 'manual',
      ...(method === 'POST' && body !== undefined ? { body } : {}),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 200 || response.status >= 300) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CALLBACK_FAILED', 'Workflow callback returned an unsuccessful status.');
    }
  } catch (error) {
    if (error instanceof LegacyWorkflowRuntimeError) throw error;
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CALLBACK_FAILED', 'Workflow callback destination was denied or unavailable.');
  } finally {
    controller.dispose();
  }
  return { nodeId: node.id, type: node.type, content: 'callback sent', data: { status: 'sent' }, output: 'callback sent' };
}

async function executeArchiveCompressNode(
  context: SdkTaskContext,
  node: LegacyWorkflowNode,
  nodeRecord: Record<string, unknown>,
  source: unknown,
  permitted: ReadonlyMap<string, LegacyWorkflowFileRef>,
): Promise<LegacyWorkflowNodeResult> {
  const items = Array.isArray(source) ? source : source === undefined || source === null ? [] : [source];
  if (items.length === 0 || items.length > 64) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_SOURCE_INVALID', 'Workflow archive source is empty or too large.');
  }
  const entries: { name: string; content: Buffer }[] = [];
  let totalInputBytes = 0;
  for (const [index, item] of items.entries()) {
    const sourceRefs = collectFileRefs(item, permitted);
    if (sourceRefs.length > 0) {
      for (const ref of sourceRefs) {
        const artifact = await context.artifacts.readWithMetadata(ref.artifactId, { signal: context.signal });
        totalInputBytes += artifact.buffer.byteLength;
        entries.push({ name: safeArchivePath(ref.fileName), content: artifact.buffer });
      }
      continue;
    }
    if (!isRecord(item) || typeof item.name !== 'string') {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_SOURCE_INVALID', 'Workflow archive entries must be authorized artifacts or named content values.');
    }
    if (Object.hasOwn(item, 'path') || Object.hasOwn(item, 'filePath')) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILESYSTEM_PATH_UNSUPPORTED', 'Workflow archive filesystem paths are not available to the durable worker.');
    }
    const content = typeof item.content === 'string'
      ? Buffer.from(item.content, 'utf8')
      : Buffer.isBuffer(item.content) || item.content instanceof Uint8Array
        ? Buffer.from(item.content)
        : undefined;
    if (!content) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_SOURCE_INVALID', 'Workflow archive entry content must be text or bytes.');
    }
    totalInputBytes += content.byteLength;
    entries.push({ name: safeArchivePath(item.name), content });
    if (entries.length > 64) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_ENTRY_LIMIT', 'Workflow archive exceeds the supported entry count.');
    }
    void index;
  }
  if (totalInputBytes > MAX_ARTIFACT_BYTES) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_TOO_LARGE', 'Workflow archive input exceeds the worker file limit.');
  }
  assertUniqueArchiveNames(entries.map((entry) => entry.name));
  const level = typeof nodeRecord.level === 'number' ? nodeRecord.level : 6;
  const zipBytes = buildZip(entries, level);
  if (zipBytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_TOO_LARGE', 'Compressed workflow archive exceeds the encrypted artifact limit.');
  }
  const fileName = safeFileName(stringField(nodeRecord, 'name') ?? `${node.id}.zip`);
  const artifact = await context.artifacts.write(zipBytes, fileName, 'application/zip', 'intermediate');
  const fileRef: LegacyWorkflowFileRef = { artifactId: artifact.artifactId, fileName, mimeType: 'application/zip', role: 'intermediate' };
  return {
    nodeId: node.id,
    type: node.type,
    content: `zip:${entries.length} entries`,
    files: [fileRef],
    data: { entries: entries.map((entry) => entry.name) },
    output: fileRef,
  };
}

async function executeArchiveExtractNode(
  context: SdkTaskContext,
  node: LegacyWorkflowNode,
  nodeRecord: Record<string, unknown>,
  source: unknown,
  permitted: ReadonlyMap<string, LegacyWorkflowFileRef>,
): Promise<LegacyWorkflowNodeResult> {
  const refs = collectFileRefs(source, permitted);
  if (refs.length !== 1) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_SOURCE_INVALID', 'Workflow archive_extract requires one authorized artifact.');
  }
  const artifact = await context.artifacts.readWithMetadata(refs[0]!.artifactId, { signal: context.signal });
  if (artifact.buffer.byteLength > MAX_ARTIFACT_BYTES) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_TOO_LARGE', 'Workflow archive input exceeds the encrypted artifact limit.');
  }
  const maxTotalBytes = typeof nodeRecord.maxTotalBytes === 'number' ? nodeRecord.maxTotalBytes : MAX_ARTIFACT_BYTES;
  const maxEntries = typeof nodeRecord.maxEntries === 'number' ? nodeRecord.maxEntries : 64;
  if (maxTotalBytes > MAX_ARTIFACT_BYTES || maxEntries > 64) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_LIMIT_UNSUPPORTED', 'Workflow archive limits exceed the durable worker artifact limits.');
  }
  let extracted: Awaited<ReturnType<typeof SafeArchiveExtractor.extractBuffer>>;
  try {
    extracted = await SafeArchiveExtractor.extractBuffer(artifact.buffer, {
      maxTotalSize: maxTotalBytes,
      maxFileCount: maxEntries,
      maxDecompressionRatio: 100,
    });
  } catch {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_INVALID', 'Workflow archive failed safe extraction.');
  }
  const baseName = stringField(nodeRecord, 'destName');
  if (baseName !== undefined) safeArchivePath(baseName);
  const files: LegacyWorkflowFileRef[] = [];
  for (const entry of extracted.entries) {
    if (entry.isDirectory) continue;
    if (!entry.content) throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_INVALID', 'Workflow archive entry did not contain file bytes.');
    const archivePath = safeArchivePath(entry.path);
    const fileName = safeFileName(baseName ? `${baseName}_${archivePath.replace(/[\\/]/g, '_')}` : archivePath.replace(/[\\/]/g, '_'));
    const written = await context.artifacts.write(entry.content, fileName, 'application/octet-stream', 'intermediate');
    files.push({ artifactId: written.artifactId, fileName, mimeType: 'application/octet-stream', role: 'intermediate' });
  }
  return {
    nodeId: node.id,
    type: node.type,
    files,
    data: { extracted: files.map(({ artifactId, fileName }) => ({ artifactId, fileName })) },
    output: files,
  };
}

async function readConnectorArtifacts(
  context: SdkTaskContext,
  refs: readonly LegacyWorkflowFileRef[],
): Promise<InvocationArtifactContent[]> {
  let totalBytes = 0;
  const artifacts: InvocationArtifactContent[] = [];
  for (const ref of refs) {
    const source = await context.artifacts.readWithMetadata(ref.artifactId, { signal: context.signal });
    const sizeBytes = source.buffer.byteLength;
    totalBytes += sizeBytes;
    if (sizeBytes < 1 || sizeBytes > CONNECTOR_ARTIFACT_MAX_BYTES || totalBytes > CONNECTOR_ARTIFACT_MAX_BYTES) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_CONNECTOR_FILES_LIMIT', 'Workflow connector file bytes exceed the connector limit.');
    }
    const sha256 = createHash('sha256').update(source.buffer).digest('hex');
    if (sha256 !== source.sha256 || typeof source.storageVersionId !== 'string' || source.storageVersionId.length === 0) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARTIFACT_INTEGRITY', 'Workflow connector artifact integrity metadata is invalid.');
    }
    const mimeType = normalizeMimeType(source.mimeType ?? ref.mimeType ?? 'application/octet-stream');
    artifacts.push({
      artifactId: ref.artifactId,
      fileName: safeFileName(source.filename ?? ref.fileName),
      mimeType,
      sizeBytes,
      sha256,
      storageVersionId: source.storageVersionId,
      contentBase64: source.buffer.toString('base64'),
    });
  }
  return artifacts;
}

async function stableConnectorDeadline(context: SdkTaskContext, stepKey: string, timeoutSec: number): Promise<string> {
  const deadlineKey = `${stepKey}:deadline`;
  const hash = contentHash({ taskKey: context.taskKey, deadlineAt: context.deadlineAt, timeoutSec });
  return context.step.run(deadlineKey, hash, async () => {
    const requested = Date.now() + timeoutSec * 1000;
    const operationDeadline = context.deadlineAt ? Date.parse(context.deadlineAt) : Number.POSITIVE_INFINITY;
    return new Date(Math.min(requested, operationDeadline)).toISOString();
  });
}

function parserMatches(parser: string, format: string): boolean {
  if (parser === 'auto') return format !== 'unknown';
  if (parser === 'excel') return ['xlsx', 'xls', 'csv'].includes(format);
  if (parser === 'word') return ['docx', 'doc'].includes(format);
  if (parser === 'pdf') return format === 'pdf';
  return false;
}

function permittedArtifactRefs(
  input: LegacyWorkflowTaskInput,
  results: Record<string, LegacyWorkflowNodeResult>,
): Map<string, LegacyWorkflowFileRef> {
  const refs = new Map<string, LegacyWorkflowFileRef>();
  for (const ref of buildFileRefs(input)) refs.set(ref.artifactId, ref);
  for (const result of Object.values(results)) {
    for (const ref of result.files ?? []) refs.set(ref.artifactId, ref);
    const outputRefs = collectTrustedOutputRefs(result.output);
    for (const ref of outputRefs) refs.set(ref.artifactId, ref);
  }
  return refs;
}

function collectTrustedOutputRefs(value: unknown): LegacyWorkflowFileRef[] {
  if (isRecord(value) && typeof value.artifactId === 'string' && ARTIFACT_ID_RE.test(value.artifactId)) {
    return [{
      artifactId: value.artifactId,
      fileName: typeof value.fileName === 'string' ? value.fileName : `artifact-${value.artifactId}`,
      ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
      ...(typeof value.role === 'string' ? { role: value.role } : {}),
    }];
  }
  if (Array.isArray(value)) return value.flatMap(collectTrustedOutputRefs);
  return [];
}

const ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function collectFileRefs(
  value: unknown,
  permitted: ReadonlyMap<string, LegacyWorkflowFileRef>,
): LegacyWorkflowFileRef[] {
  const found = new Map<string, LegacyWorkflowFileRef>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 16 || current === null || current === undefined) return;
    if (typeof current === 'string') {
      if (ARTIFACT_ID_RE.test(current) && permitted.has(current)) found.set(current, permitted.get(current)!);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (!isRecord(current)) return;
    if (typeof current.artifactId === 'string') {
      const admitted = permitted.get(current.artifactId);
      if (!ARTIFACT_ID_RE.test(current.artifactId) || !admitted) {
        throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARTIFACT_UNAUTHORIZED', 'Workflow references an artifact outside its admitted input or node outputs.');
      }
      found.set(current.artifactId, {
        ...admitted,
        ...(typeof current.fileName === 'string' ? { fileName: safeFileName(current.fileName) } : {}),
        ...(typeof current.mimeType === 'string' ? { mimeType: normalizeMimeType(current.mimeType) } : {}),
      });
      return;
    }
    if (Object.hasOwn(current, 'files')) visit(current.files, depth + 1);
  };
  visit(value, 0);
  return [...found.values()];
}

interface UrlEntry {
  readonly url: string;
  readonly fileName?: string;
  readonly mimeType?: string;
}

interface UrlAuth {
  readonly type: 'none' | 'bearer' | 'header' | 'query';
  readonly token?: string;
  readonly headerName?: string;
  readonly headerValue?: string;
  readonly queryKey?: string;
  readonly queryValue?: string;
}

const RESERVED_EGRESS_HEADER_NAMES = new Set([
  'connection', 'content-length', 'content-type', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function normalizeUrlEntries(value: unknown, nodeId: string): UrlEntry[] {
  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values) || values.length === 0) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_URLS_INVALID', `Workflow file_url_download node "${nodeId}" requires one or more URLs.`);
  }
  return values.map((entry) => {
    if (typeof entry === 'string') return { url: validateStaticHttpsUrl(entry) };
    if (!isRecord(entry) || typeof entry.url !== 'string') {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_URLS_INVALID', 'Workflow file URL entry is invalid.');
    }
    return {
      url: validateStaticHttpsUrl(entry.url),
      ...(typeof entry.filename === 'string' ? { fileName: safeFileName(entry.filename) } : {}),
      ...(typeof entry.mime_type === 'string' ? { mimeType: normalizeMimeType(entry.mime_type) } : {}),
    };
  });
}

function normalizeUrlAuth(value: unknown, allowQuery: boolean): UrlAuth {
  if (value === undefined || value === null) return { type: 'none' };
  if (!isRecord(value)) throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_AUTH_INVALID', 'Workflow egress authentication configuration is invalid.');
  const type = typeof value.type === 'string' ? value.type : 'none';
  if (!['none', 'bearer', 'header', ...(allowQuery ? ['query'] : [])].includes(type)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_AUTH_INVALID', 'Workflow egress authentication mode is unsupported.');
  }
  if (type === 'bearer') {
    if (typeof value.token !== 'string' || value.token.length === 0 || value.token.length > 8192 || /[\r\n]/.test(value.token)) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_AUTH_INVALID', 'Workflow bearer credential is malformed.');
    }
    return { type, token: value.token };
  }
  if (type === 'header') {
    if (typeof value.header_name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value.header_name)
        || typeof value.header_value !== 'string' || value.header_value.length === 0
        || value.header_value.length > 8192 || /[\r\n]/.test(value.header_value)
        || RESERVED_EGRESS_HEADER_NAMES.has(value.header_name.toLowerCase())) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_AUTH_INVALID', 'Workflow header credential is malformed.');
    }
    return { type, headerName: value.header_name, headerValue: value.header_value };
  }
  if (type === 'query') {
    if (!allowQuery || typeof value.query_key !== 'string' || value.query_key.length === 0 || value.query_key.length > 128
        || /[\r\n]/.test(value.query_key) || typeof value.query_value !== 'string' || value.query_value.length === 0
        || value.query_value.length > 8192 || /[\r\n]/.test(value.query_value)) {
      throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_AUTH_INVALID', 'Workflow query credential is malformed.');
    }
    return { type, queryKey: value.query_key, queryValue: value.query_value };
  }
  return { type: 'none' };
}

function authHeaders(auth: UrlAuth): Record<string, string> {
  if (auth.type === 'bearer' && auth.token) return { authorization: `Bearer ${auth.token}` };
  if (auth.type === 'header' && auth.headerName && auth.headerValue) return { [auth.headerName]: auth.headerValue };
  return {};
}

function applyQueryAuth(rawUrl: string, auth: UrlAuth): string {
  if (auth.type !== 'query' || !auth.queryKey || auth.queryValue === undefined) return validateStaticHttpsUrl(rawUrl);
  const url = new URL(validateStaticHttpsUrl(rawUrl));
  url.searchParams.set(auth.queryKey, auth.queryValue);
  return url.toString();
}

function validateStaticHttpsUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_EGRESS_URL_INVALID', 'Workflow egress destination is not a valid URL.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '' || url.hash !== '') {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_EGRESS_URL_INVALID', 'Workflow egress requires a literal HTTPS destination without embedded credentials.');
  }
  return url.toString();
}

function requireApprovedHttpsOrigin(pin: LegacyWorkflowSchemaPin, rawUrl: string, nodeType: string): string {
  const url = validateStaticHttpsUrl(rawUrl);
  if (!(pin.approvedEgressOrigins ?? []).includes(new URL(url).origin)) {
    throw new LegacyWorkflowRuntimeError(
      'LEGACY_WORKFLOW_EGRESS_ORIGIN_DENIED',
      `Workflow ${nodeType} destination is not in its immutable administrator-approved origin set.`,
    );
  }
  return url;
}

function makeBoundedAbortController(context: SdkTaskContext, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(context.signal.reason);
  const timer = setTimeout(() => controller.abort(new Error('workflow egress deadline exceeded')), timeoutMs);
  if (context.signal.aborted) abort();
  else context.signal.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
    },
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_URL_DOWNLOAD_FAILED', 'Workflow file URL returned no response body.');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = Buffer.from(next.value);
      size += bytes.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_TOO_LARGE', 'Workflow file URL response exceeds the worker file limit.');
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function chooseDownloadedName(entryName: string | undefined, disposition: string | null, url: string, index: number): string {
  const supplied = entryName?.trim();
  let candidate = supplied && supplied.length > 0 ? supplied : '';
  if (!candidate && disposition) {
    const match = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i.exec(disposition);
    if (match?.[1]) {
      try { candidate = decodeURIComponent(match[1]); } catch { candidate = match[1]; }
    }
  }
  if (!candidate) {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).at(-1);
    if (last) {
      try { candidate = decodeURIComponent(last); } catch { candidate = last; }
    }
  }
  return safeFileName(candidate || `download-${index + 1}`);
}

function assertAllowedExtension(fileName: string, allowedExtensions: string | undefined): void {
  if (!allowedExtensions) return;
  const allowed = allowedExtensions.split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter(Boolean);
  const extension = fileName.includes('.') ? `.${fileName.split('.').at(-1)!.toLowerCase()}` : '';
  if (allowed.length === 0 || !allowed.includes(extension)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILE_EXTENSION_DENIED', 'Workflow file URL response has a disallowed extension.');
  }
}

function normalizeMimeType(value: string): string {
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) && value.length <= 127
    ? value
    : 'application/octet-stream';
}

function safeFileName(value: string): string {
  const normalized = value.normalize('NFC').replace(/[\\/\0-\x1f\x7f]/g, '_').trim();
  if (!normalized || normalized === '.' || normalized === '..' || normalized.length > 255) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_FILENAME_INVALID', 'Workflow artifact filename is invalid.');
  }
  return normalized;
}

function safeArchivePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
      || normalized.includes('\0') || normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_PATH_INVALID', 'Workflow archive contains an unsafe entry path.');
  }
  if (Buffer.byteLength(normalized, 'utf8') > 255) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_PATH_INVALID', 'Workflow archive entry path is too long.');
  }
  return normalized;
}

function assertUniqueArchiveNames(names: readonly string[]): void {
  const normalized = names.map((name) => name.toLocaleLowerCase('en-US'));
  if (new Set(normalized).size !== normalized.length) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_DUPLICATE_PATH', 'Workflow archive contains duplicate entry names.');
  }
}

function buildZip(entries: readonly { readonly name: string; readonly content: Buffer }[], level: number): Buffer {
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_ARCHIVE_LEVEL_INVALID', 'Workflow archive compression level is invalid.');
  }
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = level === 0 ? entry.content : deflateRawSync(entry.content, { level });
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(level === 0 ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(entry.content.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(level === 0 ? 0 : 8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(entry.content.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.byteLength + compressed.byteLength;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] as string : undefined;
}

function recordOrParsedJson(data: unknown, content: string | undefined): unknown {
  if (data !== undefined && data !== null) return data;
  if (content === undefined) return undefined;
  try { return JSON.parse(content) as unknown; } catch { return undefined; }
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? 'null'; } catch {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_VALUE_INVALID', 'Workflow value could not be serialized safely.');
  }
}

function assertSingleNodeResultBudget(result: LegacyWorkflowNodeResult): void {
  if (Buffer.byteLength(safeJson(result), 'utf8') > MAX_NODE_RESULT_BYTES) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_NODE_RESULT_TOO_LARGE', 'Workflow node output exceeds the worker result limit.');
  }
}

function assertAggregateResultBudget(results: Record<string, LegacyWorkflowNodeResult>): void {
  if (Buffer.byteLength(safeJson(results), 'utf8') > MAX_AGGREGATE_NODE_RESULT_BYTES) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_RESULT_TOO_LARGE', 'Accumulated workflow node results exceed the worker memory limit.');
  }
}

function assertParallelPayloadBudget(results: Record<string, LegacyWorkflowNodeResult>, branchCount: number): void {
  const baseBytes = Buffer.byteLength(safeJson(results), 'utf8');
  if (!Number.isSafeInteger(branchCount) || branchCount < 1 || branchCount > 32
      || baseBytes * branchCount > MAX_PARALLEL_BASE_PAYLOAD_BYTES) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_PARALLEL_BASE_TOO_LARGE', 'Workflow parallel base state exceeds the supported fan-out memory limit.');
  }
}

function lastNodeOutput(results: Record<string, LegacyWorkflowNodeResult>): unknown {
  const values = Object.values(results);
  return values.length > 0 ? values[values.length - 1]!.output : undefined;
}

function aggregateUsage(results: Record<string, LegacyWorkflowNodeResult>): ConnectorUsage {
  const usage = emptyUsage();
  for (const result of Object.values(results)) {
    if (!result.usage) continue;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.costUsd += result.usage.costMicrousd / 1_000_000;
    if (result.usage.pages !== undefined) {
      usage.pages += result.usage.pages;
      usage.hasPages = true;
    }
    if (result.usage.costMicrousd > 0) usage.hasCost = true;
  }
  return usage;
}

function buildLegacyResult(
  schema: LegacyWorkflowSchema,
  sequence: readonly LegacyWorkflowNode[],
  results: Record<string, LegacyWorkflowNodeResult>,
  usage: ConnectorUsage,
) {
  const from = schema.output?.from ?? sequence[sequence.length - 1]?.id;
  const extra = schema.output?.extra_data_from;
  const final = from ? results[from] : undefined;
  const contentValue = final?.output;
  const content = typeof contentValue === 'string'
    ? contentValue
    : final?.content ?? (contentValue === undefined || contentValue === null ? null : JSON.stringify(contentValue));
  const extracted = extra ? results[extra] : undefined;
  const pipelineSteps = sequence.flatMap((node, index) => {
    const result = results[node.id];
    if (!result) return [];
    const text = result.content ?? (typeof result.output === 'string' ? result.output : null);
    return [{
      step: index + 1,
      stepName: node.id,
      processor: node.type === 'connector' ? node.connector : node.type,
      content_preview: text === null ? null : text.slice(0, MAX_PREVIEW_CHARS),
      extracted_data: result.extractedData ?? null,
    }];
  });
  return {
    schemaVersion: LEGACY_RESULT_VERSION,
    outputFormat: 'json',
    content,
    extractedData: extracted?.extractedData ?? extracted?.output ?? null,
    pipelineSteps,
    usage: usageToResult(usage),
  };
}

function emptyUsage(): ConnectorUsage {
  return { inputTokens: 0, outputTokens: 0, pages: 0, costUsd: 0, hasPages: false, hasCost: false };
}

function usageToResult(usage: ConnectorUsage) {
  return {
    ...(usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.hasPages ? { pages: usage.pages } : {}),
    ...(usage.hasCost ? { costUsd: usage.costUsd } : {}),
  };
}

async function readBranchResult(
  context: SdkTaskContext,
  resultRef: string,
  digest: string,
  parallelNodeId: string,
  branchIndex: number,
): Promise<{ nodeResults: Record<string, LegacyWorkflowNodeResult>; terminalNodeId: string | null }> {
  const artifactId = /^artifact:\/\/([0-9a-f-]{36})$/i.exec(resultRef)?.[1];
  if (!artifactId) throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow branch result reference is invalid.');
  let result: unknown;
  try {
    result = JSON.parse((await context.artifacts.read(artifactId)).toString('utf8')) as unknown;
  } catch {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow branch result could not be read.');
  }
  if (!isRecord(result) || result.schemaVersion !== BRANCH_RESULT_VERSION || result.digest !== digest
      || result.parallelNodeId !== parallelNodeId || result.branchIndex !== branchIndex || !isRecord(result.nodeResults)) {
    throw new LegacyWorkflowRuntimeError('LEGACY_WORKFLOW_JOIN_INVALID', 'Workflow branch result failed integrity validation.');
  }
  return {
    nodeResults: result.nodeResults as Record<string, LegacyWorkflowNodeResult>,
    terminalNodeId: typeof result.terminalNodeId === 'string' ? result.terminalNodeId : null,
  };
}

function assertActive(context: SdkTaskContext): void {
  if (context.signal.aborted || context.cancelRequested) {
    throw new LegacyWorkflowRuntimeError('OPERATION_CANCELLED', 'Workflow execution was cancelled.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
