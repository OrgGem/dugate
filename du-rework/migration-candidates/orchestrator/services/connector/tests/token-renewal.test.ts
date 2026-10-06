import {
  createRenewalBackedReader,
  createTokenRenewalDaemon,
  type RenewalToken,
  type VaultTokenClient,
} from '../src/vault/token-renewal';

/**
 * SEC-INT-01 prep: offline unit tests for the Vault token renewal daemon
 * (cycle 101). Virtual clock + injected scheduler — no timers, no network.
 * Covers dynamic leases (short/long renew responses), margin, re-login
 * rotation, outage keep-valid + backoff, fail-closed UNAUTHENTICATED,
 * dead-lease handling, and the zero-token-logging invariant.
 */

const SECRET_TOKEN_A = 'hvs.DYNAMIC-token-A-' + 'a'.repeat(24);
const SECRET_TOKEN_B = 'hvs.DYNAMIC-token-B-' + 'b'.repeat(24);

interface Script {
  calls: { login: number; renew: number };
  client: VaultTokenClient;
}

function world(opts: {
  leaseMs: number;
  renewResponses?: Array<RenewalToken | null | 'FAIL'>;
  loginFailuresBefore?: number;
}) {
  let clock = 1_000;
  const state = {
    loginCount: 0,
    renewCount: 0,
    scripted: [...(opts.renewResponses ?? [])],
    logLines: [] as string[],
    logDetails: [] as Record<string, unknown>[],
    scheduled: [] as Array<{ at: number; fn: () => void }>,
  };
  const now = () => clock;
  const client: VaultTokenClient = {
    async login(): Promise<RenewalToken> {
      state.loginCount += 1;
      if (opts.loginFailuresBefore && state.loginCount <= opts.loginFailuresBefore) {
        throw new Error('simulated auth backend outage');
      }
      return {
        value: SECRET_TOKEN_A + state.loginCount,
        expiresAtMs: clock + opts.leaseMs,
      };
    },
    async renew(token: RenewalToken): Promise<RenewalToken | null> {
      state.renewCount += 1;
      const next = state.scripted.shift();
      if (next === 'FAIL') throw new Error('simulated renew outage');
      if (next === null) return null;
      if (next === undefined) return { ...token, expiresAtMs: clock + opts.leaseMs };
      return next;
    },
  };
  const daemon = createTokenRenewalDaemon({
    client,
    safetyMarginMs: 10_000,
    retryBaseMs: 500,
    retryMaxMs: 8_000,
    minLeadMs: 10,
    now,
    schedule: (fn, ms) => {
      state.scheduled.push({ at: clock + ms, fn });
      return state.scheduled.length - 1;
    },
    cancel: () => undefined,
    log: (line, detail) => {
      state.logLines.push(line);
      if (detail) state.logDetails.push(detail);
    },
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { daemon, state, advance, clock: () => clock };
}

describe('renewal daemon — happy lifecycle with DYNAMIC leases', () => {
  it('start logs in, token live, next attempt = lease minus margin (server-driven)', async () => {
    const w = world({ leaseMs: 60_000 });
    await w.daemon.start();
    expect(w.daemon.state()).toBe('active');
    expect(w.daemon.current()?.value.startsWith(SECRET_TOKEN_A)).toBe(true);
    // 60s lease, 10s margin → ~50s lead from t=1000
    expect(w.daemon.nextAttemptAtMs()).toBeLessThanOrEqual(1_000 + 50_000);
    expect(w.daemon.nextAttemptAtMs()).toBeGreaterThan(1_000 + 49_000);
  });

  it('early manual tick re-arms WITHOUT calling the client', async () => {
    const w = world({ leaseMs: 60_000 });
    await w.daemon.start();
    const before = w.state.renewCount + w.state.loginCount;
    expect(await w.daemon.runOnce()).toBe('renewed');
    expect(w.state.renewCount + w.state.loginCount).toBe(before);
  });

  it('a SHORTER server lease pulls the next renewal earlier; a LONGER one pushes it back', async () => {
    const w = world({ leaseMs: 60_000 });
    await w.daemon.start();
    w.advance(50_000); // at the margin boundary of the 60s lease
    const short = w.daemon.nextAttemptAtMs()!;
    const r = await w.daemon.runOnce();
    expect(r).toBe('renewed');
    // renew default returns fresh 60s → new lead ≈ 50s from NOW
    expect(w.daemon.nextAttemptAtMs()).toBeGreaterThan(51_000);
    // now with an injected 15s lease: lead = 15s − 10s margin = 5s
    const w2 = world({ leaseMs: 60_000, renewResponses: [{ value: SECRET_TOKEN_B, expiresAtMs: 51_000 + 15_000 }] });
    await w2.daemon.start();
    w2.advance(50_000);
    expect(await w2.daemon.runOnce()).toBe('renewed');
    expect(short).toBeLessThanOrEqual(51_000); // sanity on w scheduling window
    // dynamic: 5s lead from now — NOT the fixed 50s of the original lease
    expect(w2.daemon.nextAttemptAtMs()).toBe(56_000);
  });

  it('renew → null (lease un-renewable) rotates via immediate re-login', async () => {
    const w = world({ leaseMs: 60_000, renewResponses: [null] });
    await w.daemon.start();
    const token1 = w.daemon.current()!.value;
    w.advance(50_000);
    expect(await w.daemon.runOnce()).toBe('authenticated');
    expect(w.state.loginCount).toBe(2);
    expect(w.daemon.current()!.value).not.toBe(token1);
  });
});

describe('renewal daemon — outage, expiry, fail-closed', () => {
  it('outage with STILL-VALID token: keeps serving, backs off, doubles', async () => {
    const w = world({ leaseMs: 60_000, renewResponses: ['FAIL', 'FAIL'] });
    await w.daemon.start();
    w.advance(50_000);
    expect(await w.daemon.runOnce()).toBe('retrying');
    expect(w.daemon.current()).toBeDefined(); // never dropped on transient failure
    const firstLead = w.daemon.nextAttemptAtMs()! - 51_000;
    w.advance(firstLead);
    expect(await w.daemon.runOnce()).toBe('retrying');
    const secondLead = w.daemon.nextAttemptAtMs()! - w.clock();
    expect(secondLead).toBeGreaterThan(firstLead); // exponential
    expect(w.daemon.state()).toBe('active');
  });

  it('dead lease is NEVER renewed — a fresh login happens instead', async () => {
    const w = world({ leaseMs: 60_000 });
    await w.daemon.start();
    w.advance(61_000); // past expiry entirely
    expect(await w.daemon.runOnce()).toBe('authenticated');
    expect(w.state.renewCount).toBe(0);
    expect(w.state.loginCount).toBe(2);
  });

  it('current() refuses to hand out an expired token even between ticks', async () => {
    const w = world({ leaseMs: 60_000 });
    await w.daemon.start();
    expect(w.daemon.current()).toBeDefined();
    w.advance(61_000);
    expect(w.daemon.current()).toBeUndefined();
  });

  it('sustained auth outage → UNAUTHENTICATED fail-closed, then recovery re-auths', async () => {
    const w = world({ leaseMs: 60_000, loginFailuresBefore: 5 });
    await w.daemon.start();
    expect(w.daemon.current()).toBeUndefined();
    let sawUnauthenticated = false;
    let recovered = false;
    for (let i = 0; i < 8; i++) {
      const outcome = await w.daemon.runOnce();
      if (outcome === 'unauthenticated' && !recovered) sawUnauthenticated = true;
      if (outcome === 'authenticated') {
        recovered = true;
        break;
      }
      w.advance(1_000);
    }
    expect(sawUnauthenticated).toBe(true); // fail-closed IS declared, not hidden
    expect(w.daemon.state()).toBe('active'); // and recovery re-established the lease
  });

  it('backed reader fails CLOSED while unauthenticated and never calls read', async () => {
    const w = world({ leaseMs: 60_000, loginFailuresBefore: 99 });
    let reads = 0;
    const reader = createRenewalBackedReader({
      daemon: w.daemon,
      read: async () => {
        reads += 1;
        return 'data';
      },
    });
    await w.daemon.start();
    await expect(reader()).rejects.toThrow(/VAULT_UNAUTHENTICATED/);
    expect(reads).toBe(0);
    const w2 = world({ leaseMs: 60_000 });
    let reads2 = 0;
    const reader2 = createRenewalBackedReader({
      daemon: w2.daemon,
      read: async () => {
        reads2 += 1;
        return 'data';
      },
    });
    await w2.daemon.start();
    await expect(reader2()).resolves.toBe('data');
    expect(reads2).toBe(1);
  });

  it('stop() clears the armed schedule', async () => {
    const w = world({ leaseMs: 60_000 });
    await w.daemon.start();
    w.daemon.stop();
    expect(w.daemon.nextAttemptAtMs()).toBeUndefined();
  });
});

describe('renewal daemon — secret hygiene', () => {
  it('no log line or detail ever carries the token VALUE', async () => {
    const w = world({ leaseMs: 60_000, renewResponses: [null, 'FAIL'] });
    await w.daemon.start();
    w.advance(50_000);
    await w.daemon.runOnce(); // rotates → login #2
    w.advance(50_000);
    await w.daemon.runOnce(); // renew default fine
    const dump = JSON.stringify([w.state.logLines, w.state.logDetails]);
    expect(dump).not.toContain(SECRET_TOKEN_A);
    expect(dump).not.toContain(SECRET_TOKEN_B);
    expect(dump).not.toContain('hvs.');
    // yet the operator still sees structure:
    expect(w.state.logLines.join('\n')).toMatch(/login-ok|renew-ok/);
  });
});
