// tests/workflow-builder/binding.test.ts
// Tests for binding resolution used by the schema interpreter.
import { resolveBinding, isBindingRef } from '../../lib/workflow-builder/binding';

describe('resolveBinding', () => {
  const nodeOutputs = {
    extract: { output: { data: { value: 42, name: 'Alice' } } },
    plain: { output: 'hello' },
    gen: { output: { result: 'done' } },
    arr: { output: [ {a:1}, {a:2} ] },
  };

  const bindings = {
    input: { limit: 100, tags: ['x','y'], callback: 'https://example.com/hook' },
    nodes: nodeOutputs,
    files: ['/tmp/f1.pdf'],
  };

  it('resolves literal strings as-is', () => {
    expect(resolveBinding('Hello', bindings)).toBe('Hello');
  });

  it('resolves $input.var', () => {
    expect(resolveBinding('$input.limit', bindings)).toBe(100);
  });

  it('resolves $node.path.dot', () => {
    expect(resolveBinding('$extract.data.value', bindings)).toBe(42);
    expect(resolveBinding('$extract.data.name', bindings)).toBe('Alice');
  });

  it('resolves $node whole output', () => {
    expect(resolveBinding('$plain', bindings)).toBe('hello');
  });

  it('returns undefined for missing path', () => {
    expect(resolveBinding('$extract.data.nope', bindings)).toBeUndefined();
    expect(resolveBinding('$missing.x', bindings)).toBeUndefined();
  });

  it('returns the whole object output for $node when object', () => {
    expect(resolveBinding('$gen', bindings)).toEqual({ result: 'done' });
  });

  it('resolves $files', () => {
    expect(resolveBinding('$files', bindings)).toEqual(['/tmp/f1.pdf']);
  });

  it('isBindingRef detects $-expressions', () => {
    expect(isBindingRef('$extract.data.value')).toBe(true);
    expect(isBindingRef('$input.limit')).toBe(true);
    expect(isBindingRef('plain text')).toBe(false);
    expect(isBindingRef('$files')).toBe(true);
  });
});
