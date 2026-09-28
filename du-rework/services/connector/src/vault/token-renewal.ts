/**
 * SEC-INT-01 prep (cycle 101): Vault token renewal daemon with DYNAMIC leases.
 *
 * The daemon never assumes a fixed TTL: every login/renew response carries
 * the lease the SERVER granted (Vault may shorten or extend at any time), and
 * the next attempt is scheduled at (new expiry - safety margin), clamped so a
 * tiny lease cannot busy-loop. Failure policy is fail-closed end to end:
 *
 *   - renew/login transport errors while the token is still valid → keep the
 *     token, retry with capped exponential backoff;
 *   - token expires or the server says the lease is gone (renew → null) →
 *     immediate re-login rotation;
 *   - no valid token obtainable → state UNAUTHENTICATED: current() returns
 *     undefined and consumers (the KV v2 reader below) MUST reject reads —
 *     never fall back to cached plaintext, never call the provider.
 *
 * Secrets hygiene: the token VALUE is passed only to the client port; log
 * lines carry state and numbers exclusively (offline tests sentinel-scan).
 */

export interface RenewalToken {
  value: string;
  /** Absolute epoch-ms the SERVER granted for this lease. */
  expiresAtMs: number;
}

export interface VaultTokenClient {
  login(): Promise<RenewalToken>;
  /** null ⇒ lease not renewable (must re-authenticate). Throws on outage. */
  renew(token: RenewalToken): Promise<RenewalToken | null>;
}

export type RenewalState = 'idle' | 'active' | 'retry' | 'unauthenticated';

export interface RenewalDaemonOptions {
  client: VaultTokenClient;
  safetyMarginMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  minLeadMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  log?: (line: string, detail?: Record<string, number | string>) => void;
}

export interface RenewalDaemon {
  start(): Promise<void>;
  stop(): void;
  /** One testable tick — also what the scheduler invokes. */
  runOnce(): Promise<'authenticated' | 'renewed' | 'retrying' | 'unauthenticated'>;
  current(): RenewalToken | undefined;
  state(): RenewalState;
  nextAttemptAtMs(): number | undefined;
}

const DEFAULTS = { safetyMarginMs: 30_000, retryBaseMs: 1_000, retryMaxMs: 300_000, minLeadMs: 50 };

export function createTokenRenewalDaemon(options: RenewalDaemonOptions): RenewalDaemon {
  const safetyMarginMs = options.safetyMarginMs ?? DEFAULTS.safetyMarginMs;
  const retryBaseMs = options.retryBaseMs ?? DEFAULTS.retryBaseMs;
  const retryMaxMs = options.retryMaxMs ?? DEFAULTS.retryMaxMs;
  const minLeadMs = options.minLeadMs ?? DEFAULTS.minLeadMs;
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => setTimeout(fn, Math.max(ms, minLeadMs)) as unknown);
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = options.log ?? (() => undefined);

  let token: RenewalToken | undefined;
  let state: RenewalState = 'idle';
  let failures = 0;
  let nextAt: number | undefined;
  let handle: unknown;
  let stopped = false;

  const arm = (atMs: number): void => {
    if (stopped) return;
    if (handle !== undefined) cancel(handle);
    nextAt = atMs;
    handle = schedule(() => {
      void tick();
    }, Math.max(atMs - now(), minLeadMs));
  };

  const backoffMs = (): number => Math.min(retryBaseMs * 2 ** failures, retryMaxMs);

  const leaseLead = (candidate: RenewalToken): number =>
    Math.max(candidate.expiresAtMs - safetyMarginMs - now(), minLeadMs);

  const authenticate = async (): Promise<'authenticated' | 'retrying' | 'unauthenticated'> => {
    try {
      token = await options.client.login();
      failures = 0;
      state = 'active';
      log('renewal: login-ok', { expiresInSeconds: Math.max(0, Math.floor((token.expiresAtMs - now()) / 1000)) });
      arm(now() + leaseLead(token));
      return 'authenticated';
    } catch {
      token = undefined;
      failures += 1;
      // Fail CLOSED: consumers see undefined while the retry window runs.
      state = failures >= 5 ? 'unauthenticated' : 'retry';
      log('renewal: login-failed', { consecutiveFailures: failures });
      arm(now() + backoffMs());
      return failures >= 5 ? 'unauthenticated' : 'retrying';
    }
  };

  const tick = async (): Promise<'authenticated' | 'renewed' | 'retrying' | 'unauthenticated'> => {
    if (stopped) return 'retrying';
    if (!token) return await authenticate();
    if (now() >= token.expiresAtMs) {
      // Lease expired outright — never attempt renew on a dead lease.
      return await authenticate();
    }
    if (now() < token.expiresAtMs - safetyMarginMs) {
      // Early tick (manual runOnce) — re-arm at the correct lead, no churn.
      arm(now() + leaseLead(token));
      return 'renewed';
    }
    try {
      const renewed = await options.client.renew(token);
      if (renewed === null) {
        log('renewal: lease-not-renewable-rotating', {});
        return await authenticate();
      }
      token = renewed;
      failures = 0;
      state = 'active';
      log('renewal: renew-ok', {
        leaseSeconds: Math.max(0, Math.floor((renewed.expiresAtMs - now()) / 1000)),
      });
      arm(now() + leaseLead(renewed));
      return 'renewed';
    } catch {
      failures += 1;
      if (now() + backoffMs() < token.expiresAtMs - minLeadMs) {
        // Token still genuinely valid: keep serving, retry before it dies.
        state = 'active';
        log('renewal: renew-failed-keeping-valid-token', {
          retryInMs: backoffMs(),
          consecutiveFailures: failures,
        });
        arm(Math.min(now() + backoffMs(), token.expiresAtMs - minLeadMs));
        return 'retrying';
      }
      // The remaining lease cannot outlive the retry schedule — rotate now
      // (fail-closed beats a doomed token).
      log('renewal: renew-failed-lease-too-short', { consecutiveFailures: failures });
      return await authenticate();
    }
  };

  return {
    async start(): Promise<void> {
      stopped = false;
      if (token) return;
      await authenticate();
    },
    stop(): void {
      stopped = true;
      if (handle !== undefined) {
        cancel(handle);
        handle = undefined;
      }
      nextAt = undefined;
    },
    runOnce(): Promise<'authenticated' | 'renewed' | 'retrying' | 'unauthenticated'> {
      return tick();
    },
    current(): RenewalToken | undefined {
      if (!token) return undefined;
      if (now() >= token.expiresAtMs) return undefined; // never hand out a dead lease
      return token;
    },
    state(): RenewalState {
      return state;
    },
    nextAttemptAtMs(): number | undefined {
      return nextAt;
    },
  };
}

/**
 * KV v2 reader backed by the daemon: reads go through ONLY while a live
 * lease exists; otherwise CREDENTIAL_INVALID-equivalent (fail closed — the
 * caller never reaches Vault or the provider with a stale/expired token).
 */
export function createRenewalBackedReader<T>(deps: {
  daemon: RenewalDaemon;
  read: (token: RenewalToken) => Promise<T>;
}): () => Promise<T> {
  return async () => {
    const live = deps.daemon.current();
    if (!live) throw new Error('VAULT_UNAUTHENTICATED: token lease missing or expired');
    return deps.read(live);
  };
}
