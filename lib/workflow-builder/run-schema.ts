// lib/workflow-builder/run-schema.ts
// Integration runner: executes a schema workflow against the real set of
// primitives and drives the parent operation lifecycle (pause / complete /
// fail). Wired into WORKFLOW_REGISTRY via a generic handler.
import type { WorkflowContext } from '@/lib/pipelines/workflow-engine';
import { updateProgress, pauseWorkflow, completeWorkflow, failWorkflow } from '@/lib/pipelines/workflow-engine';
import { runSchemaDag, validateSchema } from './interpreter';
import { buildExecFunc } from './real-exec';
import type { WorkflowSchema, NodeResult } from './types';

/**
 * Execute a schema workflow end-to-end.
 * - Walks the linear flow; runs contiguous blocks of non-human nodes via
 *   runSchemaDag; on a `human` node pauses for HITL approval.
 * - On completion writes output content + extracted_data per schema.output.
 */
export async function runWorkflowFromSchema(
  ctx: WorkflowContext,
  schema: WorkflowSchema,
): Promise<void> {
  const errors = validateSchema(schema);
  if (errors.length > 0) {
    await failWorkflow(ctx, new Error(`Invalid schema '${schema.slug}': ${errors.join('; ')}`));
    return;
  }

  const input: Record<string, unknown> = { ...ctx.pipelineVars };
  const files: string[] = (ctx.filesData ?? []).map((f) => f.path).filter(Boolean);
  const exec = buildExecFunc(ctx);

  const totalSteps = schema.flow.length;
  const ordered = schema.flow
    .map((id) => schema.nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => !!n);

  // 👇 Khôi phục nodeResults từ ctx khi resume (sau HITL pause)
  const nodeResults: Record<string, NodeResult> = {};
  const savedNodeResults = ctx._nodeResults;
  if (savedNodeResults && typeof savedNodeResults === 'object') {
    Object.assign(nodeResults, savedNodeResults);
  }
  const startIndex = ctx.currentStep ?? 0;

  try {
    let i = startIndex;
    while (i < ordered.length) {
      const node = ordered[i];
      await updateProgress(ctx, Math.round((i / totalSteps) * 100), `Step ${i + 1}/${totalSteps}: ${node.id}`);

      if (node.type === 'human') {
        // Lưu nodeResults vào context để resume khôi phục binding
        ctx._nodeResults = nodeResults as Record<string, unknown>;
        await updateProgress(ctx, Math.round((i / totalSteps) * 100), node.message);
        await pauseWorkflow(ctx, node.message, i + 1);
        return; // halted until resume
      }

      // Accumulate a contiguous run of non-human nodes (report writes for parallel/join).
      let j = i;
      const block: typeof ordered = [];
      while (j < ordered.length && ordered[j].type !== 'human') {
        block.push(ordered[j]);
        j++;
      }

      const blockResults = await runSchemaDag({
        schema: {
          ...schema,
          flow: block.map((n) => n.id),
          nodes: block.map((n) => ({ ...n })),
        },
        input,
        files,
        exec,
        existingResults: nodeResults, // 👈 cross-block binding
      });
      Object.assign(nodeResults, blockResults);
      i = j; // next index (either block end or human node)
    }

    // Determine final output.
    const fromId = schema.output?.from ?? ordered[ordered.length - 1]?.id;
    const extraId = schema.output?.extra_data_from;

    const finalNode = nodeResults[fromId] ?? Object.values(nodeResults)[Object.values(nodeResults).length - 1];
    let outputContent: string | null = null;
    if (finalNode) {
      outputContent = typeof finalNode.output === 'string'
        ? finalNode.output
        : finalNode.content ?? (finalNode.output !== undefined && finalNode.output !== null ? JSON.stringify(finalNode.output) : null);
    }

    let extractedData: unknown = null;
    if (extraId && nodeResults[extraId]) {
      extractedData = nodeResults[extraId].extractedData ?? nodeResults[extraId].output ?? null;
    }

    await completeWorkflow(ctx, outputContent, extractedData);
  } catch (err) {
    await failWorkflow(ctx, err);
  }
}
