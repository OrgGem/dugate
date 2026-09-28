import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * CYCLE 102 harness helper: bind a throwaway loopback server OUTSIDE the
 * OS dynamic/ephemeral band. Evidence (tester round 5 :54382, round 6b
 * :5433 lesson, mock-vault flake :61126): Windows intermittently filters
 * connections to freshly chosen ephemeral ports while LISTEN itself
 * succeeds — a per-attempt port lottery no assertion should depend on.
 * Fixed candidates in a quiet band + EADDRINUSE advance make the bind
 * deterministic; the band sits below WinNAT's reserved ranges.
 */
export async function listenLoopback(server: Server, preferPort: number, attempts = 24): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = preferPort + i;
    const ok = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        resolve(err.code === 'EADDRINUSE' ? false : (() => {
          throw err;
        })());
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (ok) {
      return (server.address() as AddressInfo).port;
    }
  }
  // full band exhausted → OS default as last resort
  return await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}
