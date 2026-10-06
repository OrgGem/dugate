// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/contracts/src/json-schema-guard.ts (lines=95) sha256=FAB971307B5A3E9F595E30EE55BC109080C1B1C9265C2D4D09AC3D3078B021AD
// why: transitive dep of manifest-validator.ts

import { SCHEMA_LIMITS } from './version';

/**
 * JSON Schema guard for business action schemas (docs 05, REG-02).
 *
 * Rules:
 * - must be a plain JSON object (already enforced by zod at manifest level)
 * - total serialized size bounded (maxSchemaBytes)
 * - no network `$ref` — only local `#/...` refs inside the accepted file
 * - `$ref` chains must be acyclic and bounded in depth
 * - object property counts bounded; array depth bounded
 */

export type SchemaProblem = { pointer: string; message: string };

const MAX_NESTING = 50;

function walk(
  node: unknown,
  pointer: string,
  depth: number,
  sizeIncrement: number,
  ctx: { bytes: number; problems: SchemaProblem[]; nodeCount: number }
): number {
  if (ctx.nodeCount > SCHEMA_LIMITS.maxManifestSchemaNodes) {
    ctx.problems.push({ pointer, message: 'manifest schema node budget exceeded' });
    return depth;
  }
  ctx.nodeCount += 1;
  ctx.bytes += sizeIncrement;

  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;
    // $ref handling
    if (typeof obj['$ref'] === 'string') {
      const ref = obj['$ref'] as string;
      if (/^https?:\/\//.test(ref)) {
        ctx.problems.push({ pointer, message: 'network $ref is not allowed' });
      } else if (!ref.startsWith('#')) {
        ctx.problems.push({
          pointer,
          message: `only local $ref allowed (got "${ref}")`,
        });
      }
      // we do not chase refs at contract layer; depth guard covers the node tree
    }
    if (typeof obj['properties'] === 'object' && obj['properties'] !== null) {
      const props = Object.keys(obj['properties'] as Record<string, unknown>);
      if (props.length > SCHEMA_LIMITS.maxProperties) {
        ctx.problems.push({
          pointer,
          message: `object schema has ${props.length} properties; v1 limit is ${SCHEMA_LIMITS.maxProperties}`,
        });
      }
    }
    if (depth > MAX_NESTING) {
      ctx.problems.push({ pointer, message: `schema nesting exceeds ${MAX_NESTING}` });
      return depth;
    }
    for (const key of Object.keys(obj)) {
      walk(obj[key], `${pointer}/${key}`, depth + 1, sizeIncrement, ctx);
    }
  }
  return depth;
}

/** Validate a single JSON Schema against the platform guard. */
export function validateJsonSchema(schema: unknown, pointer = '$'): SchemaProblem[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [{ pointer, message: 'schema must be a JSON object' }];
  }
  const problems: SchemaProblem[] = [];
  const ctx = { bytes: 0, problems, nodeCount: 0 };
  // serialized size check (approximate on the wire object)
  try {
    const serialized = JSON.stringify(schema);
    if (serialized.length > SCHEMA_LIMITS.maxSchemaBytes) {
      problems.push({
        pointer,
        message: `schema is ${serialized.length} bytes; v1 limit is ${SCHEMA_LIMITS.maxSchemaBytes}`,
      });
    }
  } catch {
    problems.push({ pointer, message: 'schema is not JSON-serializable' });
    return problems;
  }
  walk(schema, pointer, 0, 1, ctx);
  if (ctx.bytes > SCHEMA_LIMITS.maxSchemaBytes) {
    problems.push({
      pointer,
      message: `schema expands beyond ${SCHEMA_LIMITS.maxSchemaBytes} bytes`,
    });
  }
  return problems;
}