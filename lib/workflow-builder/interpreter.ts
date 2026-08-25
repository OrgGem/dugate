// lib/workflow-builder/interpreter.ts
// Core DAG runner for schema-driven workflows.
//
// Executes a WorkflowSchema against existing primitives (connector sub-steps,
// parser, file download, callback, archive). The runner is dependency-injected
// (`exec`) so it can be unit-tested without real BullMQ/db, and wired to real
// enqueueSubStep in the workflow integration.
//
// Node execution is decoupled: the DAG runner handles control-flow node types
// (parallel, join, human, input) itself, and delegates leaf node types
// (connector, file_parse, file_url_download, callback, archive_*) to `exec`.

import {
  WorkflowSchema, WorkflowNode, NodeResult, NodeType, ConnectorNode,
} from './types';
import { buildBindingContext, resolveBinding } from './binding';

export type ExecFunction = (
  node: WorkflowNode,
  resolve: (binding: unknown) => unknown,
  nodeResults: Record<string, NodeResult>,
) => Promise<Partial<NodeResult>>;

export interface RunDagOptions {
  schema: WorkflowSchema;
  input: Record<string, unknown>;
  files?: string[];
  /** Dependency-injected leaf executor. Defaults to a no-op content capture */
  exec?: ExecFunction;
  /** Existing node results to seed execution (for cross-block binding / resume) */
  existingResults?: Record<string, NodeResult>;
}

/**
 * Validate a schema's structural integrity. Returns a list of error strings
 * (empty when valid).
 */
export function validateSchema(schema: WorkflowSchema): string[] {
  const errors: string[] = [];

  if (!schema || typeof schema !== 'object') return ['Schema must be an object'];
  if (!schema.slug) errors.push('Schema requires a slug');
  if (!Array.isArray(schema.flow) || schema.flow.length === 0) errors.push('Schema requires a non-empty flow');
  if (!Array.isArray(schema.nodes)) errors.push('Schema requires a nodes array');

  if (errors.length > 0) return errors;

  const ids = new Set<string>();
  for (const n of schema.nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id '${n.id}'`);
    ids.add(n.id);

    const SUPPORTED: NodeType[] = [
      'connector', 'parallel', 'join', 'file_parse', 'file_url_download',
      'callback', 'archive_compress', 'archive_extract', 'human', 'input',
    ];
    if (!SUPPORTED.includes(n.type)) {
      errors.push(`Unsupported node type '${n.type}' for node '${n.id}'`);
      continue;
    }

    if (n.type === 'connector' && !(n as ConnectorNode).connector) {
      errors.push(`Connector node '${n.id}' requires a 'connector' slug`);
    }
  }

  for (const id of schema.flow) {
    if (!ids.has(id)) errors.push(`Flow references missing node '${id}'`);
  }

  return errors;
}

const CONTROL_NODES: NodeType[] = ['parallel', 'join', 'human', 'input'];

/**
 * Run one leaf node through the injected executor and record its result.
 */
async function runLeafNode(
  node: WorkflowNode,
  nodeResults: Record<string, NodeResult>,
  input: Record<string, unknown>,
  files: string[] | undefined,
  exec: ExecFunction,
): Promise<void> {
  const resolve = (binding: unknown) => {
    const ctx = buildBindingContext(nodeResults, input, files);
    return resolveBinding(binding, ctx);
  };

  const partial = await exec(node, resolve, nodeResults);
  nodeResults[node.id] = {
    nodeId: node.id,
    type: node.type,
    content: partial.content,
    extractedData: partial.extractedData,
    files: partial.files,
    data: partial.data ?? {},
    output: partial.output !== undefined ? partial.output : partial.content,
  };
}

/**
 * Execute an ordered list of nodes as a branch (used both for the main flow
 * and inside parallel). Parallel/join/human are handled inline.
 */
async function runNodeSequence(
  nodes: WorkflowNode[],
  nodeResults: Record<string, NodeResult>,
  input: Record<string, unknown>,
  files: string[] | undefined,
  exec: ExecFunction,
): Promise<void> {
  for (const node of nodes) {
    switch (node.type) {
      case 'parallel': {
        const branchResults: unknown[] = [];
        await Promise.all(node.branches.map(async (branch) => {
          // run each branch into the shared nodeResults map (parallel expansion)
          await runNodeSequence(branch, nodeResults, input, files, exec);
          branchResults.push(branch[branch.length - 1]?.id);
        }));
        nodeResults[node.id] = {
          nodeId: node.id,
          type: 'parallel',
          data: { branches: branchResults },
          output: branchResults,
        };
        break;
      }
      case 'join': {
        // Collect outputs of the nodes that produced data (branches already stored)
        const sources = Object.keys(nodeResults).filter((id) => id !== node.id);
        const outputs = sources
          .map((id) => nodeResults[id]?.output)
          .filter((v) => v !== undefined);
        nodeResults[node.id] = {
          nodeId: node.id,
          type: 'join',
          data: { sources },
          output: node.combine === 'first' ? outputs[0] : outputs,
        };
        break;
      }
      case 'human': {
        nodeResults[node.id] = {
          nodeId: node.id,
          type: 'human',
          data: { message: node.message, resumeInputs: node.resumeInputs },
          output: null,
        };
        break;
      }
      case 'input': {
        // Declarative: value available via $input.key; nothing to execute.
        nodeResults[node.id] = {
          nodeId: node.id,
          type: 'input',
          data: { key: node.key },
          output: input[node.key],
        };
        break;
      }
      default:
        await runLeafNode(node, nodeResults, input, files, exec);
    }
  }
}

/**
 * Run a schema workflow DAG. Returns a map of nodeId -> NodeResult.
 */
export async function runSchemaDag(options: RunDagOptions): Promise<Record<string, NodeResult>> {
  const { schema, input, files } = options;
  const exec: ExecFunction = options.exec ?? defaultExec;

  const errors = validateSchema(schema);
  if (errors.length > 0) {
    throw new Error(`Invalid workflow schema: ${errors.join('; ')}`);
  }

  const nodeResults = options.existingResults ?? {};
  const ordered = schema.flow
    .map((id) => schema.nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowNode => !!n);

  await runNodeSequence(ordered, nodeResults, input, files, exec);
  return nodeResults;
}

/**
 * Convert a results map to a plain object of {id -> result} for convenient
 * assertion / inspection.
 */
export function toNodeResults(results: Record<string, NodeResult>): Record<string, NodeResult> {
  return results;
}

/**
 * Default leaf executor — captures connector without making real calls.
 * Real wiring (enqueueSubStep / plugins) is provided by the workflow
 * integration module (real-exec.ts) and swapped in at runtime.
 */
const defaultExec: ExecFunction = async (node) => {
  return { content: node.id, data: { type: node.type } };
};

