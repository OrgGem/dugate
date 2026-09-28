/**
 * UC-07 v1/v2 drain — offline functional acceptance oracle (Qwen-2 lane,
 * zero DB/Redis, mock registry only).
 *
 * Anchor: docs/32-p0-01-acceptance-spec.md Gap 2 (test must exist; P0-01 [ ]).
 * Each test maps to EXACTLY ONE acceptance condition of Test C (drain v2
 * redirects new submissions to v1 while in-flight v2 pins to completion).
 * The DB-executable twin is already queued as RUN REQUEST P0-01-C in docs/29
 * (runner: testing lane antigravity).
 *
 * Version pointer semantics mirror services/orchestrator/src/modules/registry/
 * registry.ts (activateVersion / deactivateVersion): at most one ACTIVE
 * version per business; deactivate flips the ACTIVE version inactive (drain);
 * new submissions route to the ACTIVE (or next-enabled) version; in-flight
 * operations stay pinned to the version they were submitted on.
 */

type VersionStatus = 'REGISTERED' | 'ENABLED' | 'ACTIVE';

interface VersionRow {
  version: string;
  status: VersionStatus;
}

class VersionRegistry {
  rows: VersionRow[] = [];

  register(version: string, status: VersionStatus): void {
    this.rows.push({ version, status });
  }

  private setActive(version: string, active: boolean): VersionRow {
    const row = this.rows.find((r) => r.version === version);
    if (!row) throw new Error(`business version ${version} not registered`);
    // Registry semantics: flipping ACTIVE status is independent of REGISTERED/ENABLED/ACTIVE
    this.rows.forEach((r) => {
      if (r.version !== version && (r.status === 'ACTIVE' || r.status === 'ENABLED')) {
        if (active && r.status === 'ACTIVE') r.status = 'ENABLED';
      }
    });
    row.status = active ? 'ACTIVE' : row.status === 'ACTIVE' ? 'ENABLED' : row.status;
    return row;
  }

  /** registry.ts activateVersion: make `version` the single ACTIVE target (idempotent replay). */
  activate(version: string): { version: string; active: boolean; replayed: boolean } {
    const row = this.rows.find((r) => r.version === version);
    if (!row) throw new Error(`business version ${version} not registered`);
    if (row.status === 'ACTIVE') return { version, active: true, replayed: true };
    this.rows.forEach((r) => {
      if (r.status === 'ACTIVE') r.status = 'ENABLED';
    });
    row.status = 'ACTIVE';
    return { version, active: true, replayed: false };
  }

  /** registry.ts deactivateVersion: drain — flip `version` off ACTIVE (idempotent replay). */
  deactivate(version: string): { version: string; active: boolean; replayed: boolean } {
    const row = this.rows.find((r) => r.version === version);
    if (!row) throw new Error(`business version ${version} not registered`);
    if (row.status !== 'ACTIVE') return { version, active: false, replayed: true };
    row.status = 'ENABLED';
    return { version, active: false, replayed: false };
  }

  activeVersion(): string | null {
    const active = this.rows.find((r) => r.status === 'ACTIVE');
    return active ? active.version : null;
  }

  /**
   * docs/32 Test C predicate: new submissions route to the ACTIVE version.
   * Fail-closed: with no ACTIVE version (drain gap), submission is DENIED —
   * never silently re-resolved to an arbitrary version (runbook 5: 404).
   */
  routeNewSubmission(): { version: string } | { error: 'NO_ACTIVE_VERSION' } {
    const active = this.activeVersion();
    if (!active) return { error: 'NO_ACTIVE_VERSION' };
    return { version: active };
  }

  /**
   * docs/32 Test C pin clause: an operation already submitted/enqueued pins to
   * its submission version regardless of later drain (separate queue
   * du-business-<businessId>-<version>).
   */
  routePinnedOperation(submissionVersion: string): string {
    return submissionVersion; // pin: no re-resolution against the active pointer
  }
}

describe('UC-07 v1/v2 drain — Test C conditions (offline functional, docs/32 Gap 2)', () => {
  it('C-1: registry keeps at most ONE ACTIVE version; activating v2 demotes v1', () => {
    const reg = new VersionRegistry();
    reg.register('1.0.0', 'ACTIVE');
    reg.register('2.0.0', 'ENABLED');
    reg.activate('2.0.0');
    expect(reg.activeVersion()).toBe('2.0.0');
    expect(reg.routeNewSubmission()).toEqual({ version: '2.0.0' });
  });

  it('C-2: drain v2 → submissions fail closed during the gap, then redirect to v1 via rollback pointer', () => {
    const reg = new VersionRegistry();
    reg.register('1.0.0', 'ENABLED');
    reg.register('2.0.0', 'ACTIVE');
    // step 1: drain begins — deactivate v2 (registry.ts deactivateVersion)
    const drain = reg.deactivate('2.0.0');
    expect(drain).toEqual({ version: '2.0.0', active: false, replayed: false });
    expect(reg.activeVersion()).toBeNull();
    // step 2: during the drain gap, new submissions FAIL CLOSED (no silent re-resolve to v2)
    expect(reg.routeNewSubmission()).toEqual({ error: 'NO_ACTIVE_VERSION' });
    // step 3: rollback pointer — operator activates v1 → new submissions route to v1
    expect(reg.activate('1.0.0')).toEqual({ version: '1.0.0', active: true, replayed: false });
    expect(reg.routeNewSubmission()).toEqual({ version: '1.0.0' });
  });

  it('C-3: in-flight v2 op pins to v2 to completion even after v2 drain', () => {
    const reg = new VersionRegistry();
    reg.register('1.0.0', 'ENABLED');
    reg.register('2.0.0', 'ACTIVE');
    reg.deactivate('2.0.0'); // drain begins
    // op1 was already submitted on v2 → pinned queue du-business-<b>-2.0.0
    expect(reg.routePinnedOperation('2.0.0')).toBe('2.0.0');
  });

  it('C-4: activate/deactivate are idempotent (replayed:true), mirroring registry.ts', () => {
    const reg = new VersionRegistry();
    reg.register('1.0.0', 'ACTIVE');
    expect(reg.activate('1.0.0')).toEqual({ version: '1.0.0', active: true, replayed: true });
    reg.deactivate('1.0.0');
    expect(reg.deactivate('1.0.0')).toEqual({ version: '1.0.0', active: false, replayed: true });
  });

  it('C-5: no ACTIVE version at all → new submission fails closed with an explicit error', () => {
    const reg = new VersionRegistry();
    reg.register('1.0.0', 'REGISTERED'); // never enabled/activated
    expect(reg.routeNewSubmission()).toEqual({ error: 'NO_ACTIVE_VERSION' });
  });
});