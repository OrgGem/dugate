export function readPath(value: unknown, path: string): unknown {
  const segments = path.split('.');
  if (segments.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) {
    return undefined;
  }
  return segments.reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return Object.hasOwn(current, segment) ? (current as Record<string, unknown>)[segment] : undefined;
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
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(destination) || !/^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(sourcePath)
      || destination.split('.').some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')
      || sourcePath.split('.').some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) {
      throw new Error('Mapping paths must be simple declarative property paths.');
    }
  }
}
