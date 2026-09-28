/**
 * Console-capture fixture for developer-mode logging regressions (Reviewer
 * Finding 1, cycle 138+: a future config-loaded startup log must never print
 * tokens or credentials while DU_DEVELOP=true).
 *
 * Usage:
 *   const cap = captureConsole();
 *   try {
 *     await main(env);
 *   } finally {
 *     cap.restore();
 *   }
 *   expect(cap.joined()).not.toContain(workerToken);
 *
 * The proxy stringifies every argument out-of-band (JSON when possible, the
 * raw string otherwise) so objects, template strings and Error payloads are
 * ALL visible to assertions — a vacuous capture is itself a finding.
 */

export interface CapturedConsoleCall {
  level: 'log' | 'info' | 'debug' | 'warn' | 'error';
  args: string[];
}

export interface ConsoleCapture {
  calls: CapturedConsoleCall[];
  joined(): string;
  restore(): void;
}

const LEVELS = ['log', 'info', 'debug', 'warn', 'error'] as const;

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `Error(${value.name}): ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function captureConsole(): ConsoleCapture {
  const globals = globalThis as unknown as Record<string, unknown>;
  const real = Object.fromEntries(
    LEVELS.map((level) => [level, console[level].bind(console)]),
  ) as Record<(typeof LEVELS)[number], (...a: unknown[]) => void>;
  const calls: CapturedConsoleCall[] = [];

  for (const level of LEVELS) {
    console[level] = (...args: unknown[]): void => {
      calls.push({ level, args: args.map(stringify) });
      // Silence stdout during tests but KEEP the stream live: jest and
      // anything downstream still sees a functioning console after restore.
    };
  }

  return {
    calls,
    joined: () => calls.map((c) => c.args.join(' ')).join('\n'),
    restore: () => {
      for (const level of LEVELS) {
        globals[`console`] && Object.assign(console, { [level]: real[level] });
      }
    },
  };
}
