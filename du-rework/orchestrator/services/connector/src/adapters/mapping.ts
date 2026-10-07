export function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function writeMapped(
  target: Record<string, unknown>,
  mapping: Readonly<Record<string, string>>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [destination, sourcePath] of Object.entries(mapping)) {
    const value = readPath(source, sourcePath);
    if (value !== undefined) target[destination] = value;
  }
  return target;
}

export function assertSafeMapping(mapping: Readonly<Record<string, string>>): void {
  for (const [destination, sourcePath] of Object.entries(mapping)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(destination) || !/^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(sourcePath)) {
      throw new Error('Mapping paths must be simple declarative property paths.');
    }
  }
}
