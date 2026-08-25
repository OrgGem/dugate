// lib/workflow-builder/binding.ts
// Resolution of $path binding references used by the schema interpreter.
import { resolveDotPath } from '@/lib/pipelines/processors/response-parser';

export interface BindingContext {
  nodes: Record<string, { output?: unknown; data?: Record<string, unknown>; content?: string }>;
  input: Record<string, unknown>;
  files?: string[];
}

const BINDING_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)(\..*)?$/;

/** Return true if a value is a $binding reference. */
export function isBindingRef(value: unknown): value is string {
  return typeof value === 'string' && BINDING_RE.test(value);
}

/**
 * Resolve a binding. Strings starting with '$' are interpreted as references:
 *   $input.var      -> business variable
 *   $node.path.dot  -> output of node 'node' at dot-path 'path.dot'
 *   $node           -> whole output of node
 *   $files          -> uploaded files array
 * Literals are returned as-is.
 */
export function resolveBinding(value: unknown, ctx: BindingContext): unknown {
  if (!isBindingRef(value)) return value;

  const match = BINDING_RE.exec(value)!;
  const name = match[1];
  const rest = match[2] ? match[2].slice(1) : null; // strip leading '.'

  if (name === 'input') {
    return rest ? resolveDotPath(ctx.input, rest) : ctx.input;
  }
  if (name === 'files') {
    return ctx.files;
  }

  const node = ctx.nodes[name];
  if (!node) return undefined;

  // Top-level fields: $a.content, $a.extractedData, $a.files, $a.data
  // Also handle sub-paths: $a.data.meta -> (node.data).meta
  // Empty data {} falls through to output (backwards compatible with $node.data.x on outputs).
  const TOP_LEVEL = new Set(['content', 'extractedData', 'files', 'data']);
  if (rest) {
    const dot = rest.indexOf('.');
    const first = dot === -1 ? rest : rest.slice(0, dot);
    if (TOP_LEVEL.has(first)) {
      const val = (node as any)[first];
      const isEmptyData = first === 'data' && typeof val === 'object' && val !== null && Object.keys(val).length === 0;
      if (val !== undefined && !isEmptyData) {
        const sub = dot === -1 ? null : rest.slice(dot + 1);
        return sub ? resolveDotPath(val, sub) : val;
      }
    }
  }

  const root = node.output !== undefined ? node.output : node.data;
  if (root === undefined) return node.content;
  if (!rest) return root;
  return resolveDotPath(root, rest);
}

/** Build the binding context from node results + inputs. */
export function buildBindingContext(
  nodeResults: Record<string, { output?: unknown; data?: Record<string, unknown>; content?: string }>,
  input: Record<string, unknown>,
  files?: string[],
): BindingContext {
  return { nodes: nodeResults, input, files };
}
