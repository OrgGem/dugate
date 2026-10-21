import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BusinessManifest,
  BusinessManifestSchema,
  ManifestValidationResult,
} from './manifest';
import { isSecretParameterKey } from './profile-policy';
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

/* ------------------------------------------------------------------ */
/* PC-05: parameterResolution semantic validation                     */
/* ------------------------------------------------------------------ */

interface ManifestProblem {
  pointer: string;
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function topLevelProperties(schema: unknown): Record<string, unknown> {
  const record = asRecord(schema);
  const properties = record ? asRecord(record['properties']) : null;
  return properties ?? {};
}

/** Keys the schema object declares among `candidates`, in candidate order. */
function declaredAmong(schema: Record<string, unknown>, candidates: readonly string[]): string[] {
  return candidates.filter((key) => Object.hasOwn(schema, key));
}

const SOURCE_DECLARATION_CONFLICTS = [
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
] as const;

/**
 * Bounded search for a `default` anywhere below the property's own top level.
 *
 * Only called when the property schema has no own `default`, so any hit is by
 * definition nested. The walk is depth- and node-bounded because the schema is
 * caller-supplied JSON: an unbounded recursion here would be a
 * publication-time DoS. Inside a `properties` map the map's VALUES are schemas,
 * which the generic recursion already visits.
 */
function hasNestedDefault(schema: unknown): boolean {
  let visited = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 4 || visited > 200) return false;
    if (Array.isArray(node)) {
      for (const item of node) {
        visited += 1;
        if (walk(item, depth + 1)) return true;
      }
      return false;
    }
    const record = asRecord(node);
    if (!record) return false;
    for (const key of Object.keys(record)) {
      visited += 1;
      if (key === 'default') return true;
      if (walk(record[key], depth + 1)) return true;
    }
    return false;
  };
  return walk(schema, 0);
}

/**
 * PC-05 — the eight semantic checks the plan requires before a manifest may
 * claim authoritative per-field source resolution.
 *
 * Absence of `parameterResolution` returns no problems: v1 manifests must stay
 * registrable byte-for-byte, and the capability only changes the digest when it
 * is actually declared (PC-01 case I2).
 */
function parameterResolutionProblems(
  action: {
    inputSchema: unknown;
    profileSchema: unknown;
    parameterResolution?: { fields: Record<string, 'requestDefaults' | 'profileSettings'>; applyTopLevelDefaults: boolean };
  },
  index: number,
): ManifestProblem[] {
  const capability = action.parameterResolution;
  if (!capability) return [];

  const problems: ManifestProblem[] = [];
  const base = `$.actions[${index}].parameterResolution`;
  const entries = Object.entries(capability.fields);
  const inputProperties = topLevelProperties(action.inputSchema);
  const profileProperties = topLevelProperties(action.profileSchema);

  // (1) A declared capability that maps nothing cannot govern anything, and
  // would silently behave like v1 while claiming v2 semantics.
  if (entries.length === 0) {
    problems.push({ pointer: `${base}.fields`, message: 'must map at least one property' });
  }

  for (const [name, source] of entries) {
    const pointer = `${base}.fields.${name}`;
    const properties = source === 'requestDefaults' ? inputProperties : profileProperties;
    const schemaName = source === 'requestDefaults' ? 'inputSchema' : 'profileSchema';

    // (2)/(3) The mapping must target the schema that owns that source. A typo
    // or a mapping to the other schema would make the declaration a no-op.
    if (!Object.hasOwn(properties, name)) {
      problems.push({
        pointer,
        message: `property "${name}" is not declared by ${schemaName}.properties`,
      });
      continue;
    }

    const property = properties[name];

    if (source === 'profileSettings') {
      // profileSettings values live only in the profile policy, so a schema
      // declaration conflict is the only structural risk here.
      const profileRecord = asRecord(property);
      const conflicts = profileRecord ? declaredAmong(profileRecord, SOURCE_DECLARATION_CONFLICTS) : [];
      if (conflicts.length > 0) {
        problems.push({
          pointer,
          message: `property "${name}" is declared by ${conflicts.join('/')}; its source cannot be resolved`,
        });
      }
      continue;
    }

    // (4) requestDefaults fill request input, so they must never carry a
    // credential. This is defense in depth beside ProfileGroupRequestDefaultsSchema.
    if (isSecretParameterKey(name)) {
      problems.push({
        pointer,
        message: `property "${name}" looks like a credential and cannot be a request default`,
      });
    }

    const record = asRecord(property);

    // (5)/(6) A $ref or combinator property has no single authoritative
    // declaration to read a lock or a default from.
    const conflicts = record ? declaredAmong(record, SOURCE_DECLARATION_CONFLICTS) : [];
    if (conflicts.length > 0) {
      problems.push({
        pointer,
        message: `property "${name}" is declared by ${conflicts.join('/')}; its source cannot be resolved`,
      });
      continue;
    }

    if (capability.applyTopLevelDefaults) {
      // (7) A boolean JSON Schema (`true`) is legal JSON Schema but has no
      // top-level default, so claiming default application is meaningless.
      if (!record) {
        problems.push({
          pointer,
          message: `property "${name}" must be an object schema so its top-level default can be applied`,
        });
        continue;
      }
      // (8) Only `properties.<name>.default` is supported. A default that lives
      // under `items`/`properties`/`$defs` and nowhere else would be silently
      // dropped, so the publication must fail instead.
      if (!Object.hasOwn(record, 'default') && hasNestedDefault(record)) {
        problems.push({
          pointer,
          message: `property "${name}" declares only nested defaults; only inputSchema.properties.<name>.default is supported`,
        });
      }
    }
  }

  return problems;
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

  const problems: ManifestProblem[] = [];
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
    // PC-05: parameterResolution semantic checks (only when the capability is
    // declared; absence keeps v1 semantics and validation byte-identical).
    for (const problem of parameterResolutionProblems(a, idx)) {
      problems.push(problem);
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