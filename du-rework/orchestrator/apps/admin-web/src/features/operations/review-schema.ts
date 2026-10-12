/** Bounded subset of JSON Schema rendered by the human-review form. Unknown
 * assertions use the explicit JSON editor, with the runtime as authority. */
export type ReviewScalar = string | number | boolean | null;
export interface ReviewField {
  name: string;
  title: string;
  description?: string;
  path: string[];
  required: boolean;
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean';
  options?: ReviewScalar[];
  children?: ReviewField[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: boolean;
}
export type ReviewModel = { supported: true; fields: ReviewField[]; additionalProperties: boolean } | { supported: false; reason: string };
const allowedKeys = new Set(['type', 'properties', 'required', 'title', 'description', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'additionalProperties', '$schema', '$id', 'default', 'examples']);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);

export function reviewModel(schema: unknown): ReviewModel {
  let count = 0;
  function field(raw: unknown, name: string, path: string[], required: boolean): ReviewField {
    if (!record(raw) || path.length > 4 || ++count > 50) throw new Error('This schema needs the advanced JSON editor (complexity limit).');
    if (Object.keys(raw).some(key => !allowedKeys.has(key))) throw new Error('This schema contains validation rules that need the advanced JSON editor.');
    const type = raw.type;
    if (!['object', 'string', 'number', 'integer', 'boolean'].includes(String(type))) throw new Error('This schema uses a type that needs the advanced JSON editor.');
    const result: ReviewField = { name, path, required, title: typeof raw.title === 'string' ? raw.title : name, type: type as ReviewField['type'] };
    if (typeof raw.description === 'string') result.description = raw.description;
    if (raw.enum !== undefined) {
      if (!Array.isArray(raw.enum) || !raw.enum.length || raw.enum.length > 100 || raw.enum.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('This enumeration needs the advanced JSON editor.');
      result.options = raw.enum as ReviewScalar[];
    }
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength'] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error('This schema has an invalid numeric constraint.');
        result[key] = raw[key];
      }
    }
    if (type === 'object') {
      if (raw.enum !== undefined || (raw.additionalProperties !== undefined && typeof raw.additionalProperties !== 'boolean') || (raw.properties !== undefined && !record(raw.properties))) throw new Error('This object schema needs the advanced JSON editor.');
      const properties = (raw.properties ?? {}) as Record<string, unknown>;
      if (Object.keys(properties).some(key => unsafe.has(key))) throw new Error('This schema requires the advanced JSON editor.');
      if (raw.required !== undefined && (!Array.isArray(raw.required) || raw.required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key)))) throw new Error('This schema has unsupported required fields.');
      const requiredKeys = (raw.required ?? []) as string[];
      result.additionalProperties = raw.additionalProperties !== false;
      result.children = Object.entries(properties).map(([key, value]) => field(value, key, [...path, key], requiredKeys.includes(key)));
    }
    return result;
  }
  try {
    const root = field(schema, 'Review response', [], true);
    if (root.type !== 'object') return { supported: false, reason: 'A non-object response requires the advanced JSON editor.' };
    return { supported: true, fields: root.children ?? [], additionalProperties: root.additionalProperties !== false };
  } catch (error) { return { supported: false, reason: error instanceof Error ? error.message : 'Use the advanced JSON editor.' }; }
}

export function reviewValueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) { if (!record(current) || !Object.hasOwn(current, key)) return undefined; current = current[key]; }
  return current;
}
export function setReviewValue(value: unknown, path: string[], next: unknown): Record<string, unknown> {
  if (!path.length || path.some(key => unsafe.has(key))) throw new Error('Invalid review field');
  const root: Record<string, unknown> = record(value) ? { ...value } : {};
  let current = root;
  for (const key of path.slice(0, -1)) { const child = current[key]; current[key] = record(child) ? { ...child } : {}; current = current[key] as Record<string, unknown>; }
  const key = path[path.length - 1]!;
  if (next === undefined) delete current[key]; else current[key] = next;
  return root;
}

export function validateReview(model: ReviewModel, raw: string): string[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return ['Enter valid JSON before submitting.']; }
  if (!model.supported) return []; // The server validates the complete original schema.
  if (!record(value)) return ['The review response must be an object.'];
  const errors: string[] = [];
  function object(fields: ReviewField[], data: Record<string, unknown>, label: string, additional: boolean) {
    if (!additional && Object.keys(data).some(key => !fields.some(field => field.name === key))) errors.push(`${label}: remove unknown fields.`);
    for (const field of fields) {
      const name = field.path.join('.');
      const present = Object.hasOwn(data, field.name);
      if (!present) { if (field.required) errors.push(`${name} is required.`); continue; }
      const v = data[field.name];
      if (field.type === 'object') { if (!record(v)) errors.push(`${name} must be an object.`); else object(field.children ?? [], v, name, field.additionalProperties !== false); continue; }
      const expected = field.type === 'integer' ? 'number' : field.type;
      if (typeof v !== expected || (typeof v === 'number' && (!Number.isFinite(v) || (field.type === 'integer' && !Number.isInteger(v))))) { errors.push(`${name} must be ${field.type}.`); continue; }
      if (field.options && !field.options.some(option => option === v)) errors.push(`${name}: choose an allowed value.`);
      if (typeof v === 'number') {
        if (field.minimum !== undefined && v < field.minimum) errors.push(`${name} must be at least ${field.minimum}.`);
        if (field.maximum !== undefined && v > field.maximum) errors.push(`${name} must be at most ${field.maximum}.`);
      }
      if (typeof v === 'string') {
        const length = Array.from(v).length;
        if (field.minLength !== undefined && length < field.minLength) errors.push(`${name} needs at least ${field.minLength} characters.`);
        if (field.maxLength !== undefined && length > field.maxLength) errors.push(`${name} allows at most ${field.maxLength} characters.`);
      }
    }
  }
  object(model.fields, value, 'Response', model.additionalProperties);
  return errors;
}
