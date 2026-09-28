/**
 * R1-C sink scanner: recursive string harvest used to prove a sentinel never reaches a sink.
 * Walks: strings (incl. JSON-looking strings re-parsed), Errors (message/cause/stack/aggregate),
 * Buffers/TypedArrays/DataViews (utf8), Maps/Sets, plain objects/arrays, with cycle guard.
 * Usage: expect(scanForSentinels(root, sentinels)).toEqual([])
 */

export interface LeakHit {
  readonly sentinel: string;
  readonly path: string;
}

interface Frame {
  value: unknown;
  path: string;
  depth: number;
}

const MAX_NODES = 50_000;

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof DataView) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8');
  }
  return null;
}

export function scanForSentinels(root: unknown, sentinels: readonly string[]): LeakHit[] {
  const hits: LeakHit[] = [];
  if (sentinels.length === 0) return hits;
  const seen = new WeakSet<object>();
  const stack: Frame[] = [{ value: root, path: '$', depth: 0 }];
  let nodes = 0;
  while (stack.length > 0 && nodes < MAX_NODES) {
    const frame = stack.pop() as Frame;
    nodes++;
    const { value, path, depth } = frame;
    if (value === null || value === undefined) continue;
    if (depth > 32) continue;

    const text = asText(value);
    if (text !== null) {
      for (const s of sentinels) {
        if (text.includes(s)) hits.push({ sentinel: s, path });
      }
      const trimmed = text.trimStart();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 200_000) {
        try {
          stack.push({ value: JSON.parse(text) as unknown, path: `${path}!json`, depth: depth + 1 });
        } catch {
          /* not JSON after all */
        }
      }
      continue;
    }

    if (typeof value !== 'object') continue;
    if (seen.has(value as object)) continue;
    seen.add(value as object);

    if (value instanceof Error) {
      stack.push({ value: value.message, path: `${path}.message`, depth: depth + 1 });
      stack.push({ value: value.stack ?? null, path: `${path}.stack`, depth: depth + 1 });
      const err = value as Error & { cause?: unknown; errors?: unknown };
      if ('cause' in err) stack.push({ value: err.cause, path: `${path}.cause`, depth: depth + 1 });
      if (Array.isArray(err.errors)) {
        err.errors.forEach((e, i) => stack.push({ value: e, path: `${path}.errors[${i}]`, depth: depth + 1 }));
      }
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((v, i) => stack.push({ value: v, path: `${path}[${i}]`, depth: depth + 1 }));
      continue;
    }
    if (value instanceof Map) {
      for (const [k, v] of value.entries()) {
        stack.push({ value: v, path: `${path}{${String(k)}}`, depth: depth + 1 });
      }
      continue;
    }
    if (value instanceof Set) {
      for (const v of value.values()) stack.push({ value: v, path: `${path}{set}`, depth: depth + 1 });
      continue;
    }

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      stack.push({ value: v, path: `${path}.${k}`, depth: depth + 1 });
    }
  }
  return hits;
}

/** Convenience for raw text sinks (stdout lines, DB columns). */
export function scanText(text: string, sentinels: readonly string[]): LeakHit[] {
  return scanForSentinels({ text }, sentinels);
}
