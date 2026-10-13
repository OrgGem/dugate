import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BusinessManifest,
  BusinessManifestSchema,
  ManifestValidationResult,
} from './manifest';
import { validateJsonSchema } from './json-schema-guard';

/**
 * Canonical JSON: stable key ordering for hashing and replay comparison.
 * Keys sorted alphabetically; undefined values dropped.
 */
export function canonicalize(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {};
      const keys = Object.keys(v as Record<string, unknown>).sort();
      for (const k of keys) {
        const val = (v as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = sort(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function hashManifest(manifest: BusinessManifest): string {
  const canonical = canonicalize(manifest);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function queueNameFor(businessId: string, version: string): string {
  return `du-business-${businessId}-${version}`;
}

/**
 * Full manifest validation (REG-01..04):
 * 1. Zod structural check
 * 2. Semantic checks: unique action names, slot names per action, schema guards
 * 3. Canonical hash
 */
export function validateManifest(unknownInput: unknown): ManifestValidationResult {
  const zodResult = BusinessManifestSchema.safeParse(unknownInput);
  if (!zodResult.success) {
    const problems = zodResult.error.issues.map((i) => ({
      pointer: i.path.length > 0 ? `$.${i.path.join('.')}` : '$',
      message: i.message,
    }));
    return { ok: false, problems };
  }

  const problems: { pointer: string; message: string }[] = [];
  const manifest = zodResult.data;

  // unique action names
  const seen = new Set<string>();
  manifest.actions.forEach((a, idx) => {
    if (seen.has(a.name)) {
      problems.push({ pointer: `$.actions[${idx}].name`, message: `duplicate action "${a.name}"` });
    }
    seen.add(a.name);
  });

  // schema guards (input/output/profile)
  manifest.actions.forEach((a, idx) => {
    for (const field of ['inputSchema', 'outputSchema', 'profileSchema'] as const) {
      const schemaProblems = validateJsonSchema(a[field], `$.actions[${idx}].${field}`);
      for (const p of schemaProblems) {
        problems.push({ pointer: p.pointer, message: p.message });
      }
    }
    // unique slot names per action
    const slotNames = new Set<string>();
    a.connectorSlots.forEach((s, si) => {
      if (slotNames.has(s.name)) {
        problems.push({
          pointer: `$.actions[${idx}].connectorSlots[${si}].name`,
          message: `duplicate slot "${s.name}"`,
        });
      }
      slotNames.add(s.name);
    });
    // artifact policy coherence
    if (a.artifactPolicy.minFiles > a.artifactPolicy.maxFiles) {
      problems.push({
        pointer: `$.actions[${idx}].artifactPolicy`,
        message: 'minFiles must be <= maxFiles',
      });
    }
  });

  // handler kinds must cover all actions (workers dispatch by handler kind)
  const kinds = new Set(manifest.runtime.handlerKinds);
  manifest.actions.forEach((a, idx) => {
    if (!kinds.has(a.name) && !kinds.has('root')) {
      problems.push({
        pointer: `$.actions[${idx}].name`,
        message: `handler kind "${a.name}" not declared in runtime.handlerKinds`,
      });
    }
  });

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    manifest,
    digest: hashManifest(manifest),
    queue: queueNameFor(manifest.businessId, manifest.version),
    canonicalJson: canonicalize(manifest),
  };
}

/** Re-export for consumers. */
export { BusinessManifestSchema };
export type { BusinessManifest };