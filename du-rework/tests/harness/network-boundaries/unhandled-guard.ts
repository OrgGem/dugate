/**
 * R1-C rejection guard: collects process-level unhandledRejections so the listener-oracle
 * suites (which deliberately leave racing promises that the fix will later claim) fail
 * loudly instead of silently (report sec.6.3 B-race). Install in beforeAll, restore in afterAll.
 */
export interface RejectionGuard {
  readonly reasons: string[];
  assertClean(label: string): void;
  restore(): void;
}

export function installRejectionGuard(): RejectionGuard {
  const reasons: string[] = [];
  const handler = (reason: unknown): void => {
    reasons.push(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  };
  process.on('unhandledRejection', handler);
  return {
    reasons,
    assertClean(label: string): void {
      if (reasons.length > 0) {
        throw new Error(`${label}: ${reasons.length} unhandledRejection(s):\n${reasons.join('\n')}`);
      }
    },
    restore(): void {
      process.off('unhandledRejection', handler);
    },
  };
}
