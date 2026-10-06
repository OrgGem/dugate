import { isMainThread, parentPort, workerData } from 'node:worker_threads';

interface Rule { pattern: string; flags?: string; replacement?: string }
interface Request { data: unknown; rules: Rule[] }

/** Display copy only. Replacement is global, including string object keys. */
export function redactRequestValues(data: unknown, rules: Rule[]): unknown {
  const patterns = rules.map(rule => ({ regex: new RegExp(rule.pattern, 'g' + (rule.flags ?? '')), replacement: rule.replacement ?? '[REDACTED]' }));
  const replace = (value: string): string => patterns.reduce((text, rule) => text.replace(rule.regex, rule.replacement), value);
  let visited = 0;
  function walk(value: unknown, depth: number): unknown {
    if (depth > 32 || ++visited > 10000) throw new Error('DISPLAY_LIMIT');
    if (typeof value === 'string') return replace(value);
    if (typeof value === 'number') {
      const text = String(value);
      const masked = replace(text);
      return masked === text ? value : masked;
    }
    if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [replace(key), walk(child, depth + 1)]));
    }
    return value;
  }
  return walk(data, 0);
}

if (!isMainThread) {
  const request = workerData as Request;
  try { parentPort?.postMessage({ ok: true, data: redactRequestValues(request.data, request.rules) }); }
  catch { parentPort?.postMessage({ ok: false }); }
}
