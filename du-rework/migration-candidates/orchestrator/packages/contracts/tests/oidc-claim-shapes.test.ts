import {
  OIDC_CLAIM_SHAPE_CONTRACT,
  assertOidcClaimShapeContract,
  dominatesOidcPrivilege,
  type OidcPrivilege,
} from '../src/oidc-claim-shapes';

/**
 * Self-consistency of the OIDC claim-shape contract (SEC, Reviewer Turn 40).
 *
 * This suite proves the ASSERTION has teeth: a table that lets the bearer
 * surface outrank the browser surface, that grants a hostile shape any
 * privilege, that binds the two surfaces to different tenants, or that is
 * trimmed until it proves nothing, must all be rejected. The table's
 * agreement with the two live mappers is proven in services/orchestrator
 * (tests/oidc-claim-shape-contract-offline.test.ts) — that package owns the
 * code, this package owns the rule.
 */

type Row = {
  id: string;
  why: string;
  hostile: boolean;
  claims: Record<string, unknown>;
  adminShell: OidcPrivilege;
  platformApi: OidcPrivilege;
};

function clone(mutate: (rows: Row[]) => void): Row[] {
  const rows: Row[] = OIDC_CLAIM_SHAPE_CONTRACT.map((r) => ({
    id: r.id,
    why: r.why,
    hostile: r.hostile,
    claims: { ...r.claims },
    adminShell: r.adminShell,
    platformApi: r.platformApi,
  }));
  mutate(rows);
  return rows;
}

function replace(id: string, patch: Partial<Row>): Row[] {
  return clone((rows) => {
    const i = rows.findIndex((r) => r.id === id);
    const hit = rows[i];
    if (!hit) throw new Error('fixture row missing: ' + id);
    rows[i] = { ...hit, ...patch };
  });
}

describe('oidc claim-shape contract: the pinned table is admissible', () => {
  it('satisfies its own assertion', () => {
    expect(() => assertOidcClaimShapeContract()).not.toThrow();
  });

  it('gives every row a stable unique id and a written rationale', () => {
    const ids = OIDC_CLAIM_SHAPE_CONTRACT.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of OIDC_CLAIM_SHAPE_CONTRACT) {
      expect(r.id.length).toBeGreaterThan(0);
      expect(r.why.trim().length).toBeGreaterThan(20);
    }
  });

  it('pins the two granting shapes and the hostile class', () => {
    const platform = OIDC_CLAIM_SHAPE_CONTRACT.filter(
      (r) => r.adminShell.kind === 'platform-write' || r.platformApi.kind === 'platform-write'
    );
    const tenant = OIDC_CLAIM_SHAPE_CONTRACT.filter(
      (r) => r.adminShell.kind === 'tenant-write' || r.platformApi.kind === 'tenant-write'
    );
    const hostile = OIDC_CLAIM_SHAPE_CONTRACT.filter((r) => r.hostile);
    expect(platform.map((r) => r.id)).toEqual(['platform-admin-boolean']);
    expect(tenant.map((r) => r.id)).toEqual(['single-tenant']);
    expect(hostile.length).toBeGreaterThanOrEqual(5);
  });

  it('only ever grants the SHELL MORE than the API, and never write', () => {
    const shellHeavier = OIDC_CLAIM_SHAPE_CONTRACT.filter(
      (r) => r.adminShell.kind !== r.platformApi.kind
    );
    expect(shellHeavier.length).toBeGreaterThan(0);
    for (const r of shellHeavier) {
      expect(r.adminShell.kind).toBe('read-only');
      expect(r.platformApi.kind).toBe('none');
    }
  });

  it('documents the multi-tenant divergence explicitly', () => {
    const row = OIDC_CLAIM_SHAPE_CONTRACT.find(
      (r) => r.id === 'multi-tenant-deliberate-divergence'
    );
    expect(row).toBeDefined();
    expect(row!.adminShell).toEqual({ kind: 'read-only' });
    expect(row!.platformApi).toEqual({ kind: 'none' });
    expect(row!.hostile).toBe(false);
    expect(row!.why).toMatch(/DELIBERATE/);
  });

  it('keeps the hostile class inert on BOTH surfaces', () => {
    for (const r of OIDC_CLAIM_SHAPE_CONTRACT.filter((x) => x.hostile)) {
      expect(r.platformApi).toEqual({ kind: 'none' });
      expect(r.adminShell).toEqual({ kind: 'read-only' });
    }
  });
});

describe('oidc claim-shape contract: the assertion rejects escalation', () => {
  it('rejects a bearer surface that outranks the admin shell', () => {
    const bad = replace('single-tenant', { platformApi: { kind: 'platform-write' } });
    expect(() => assertOidcClaimShapeContract(bad)).toThrow(/grants the bearer API/);
  });

  it('rejects turning a hostile shape into a granting one', () => {
    // Shell side: read-only is the most the hostile class may ever mint.
    const badShell = replace('platform-admin-string', {
      adminShell: { kind: 'tenant-write', tenantId: 'tenant-a' },
    });
    expect(() => assertOidcClaimShapeContract(badShell)).toThrow(/hostile shape/);
    // API side: the hostile rule is only reached when the two surfaces AGREE
    // on the grant — if the API outranks the shell, the ordering rule above
    // rejects the row first, which is still a rejection.
    const badApi = replace('tenant-member-not-a-string', {
      adminShell: { kind: 'tenant-write', tenantId: '42' },
      platformApi: { kind: 'tenant-write', tenantId: '42' },
    });
    expect(() => assertOidcClaimShapeContract(badApi)).toThrow(/hostile shape/);
    const outranking = replace('tenant-member-not-a-string', {
      platformApi: { kind: 'tenant-write', tenantId: '42' },
    });
    expect(() => assertOidcClaimShapeContract(outranking)).toThrow(/grants the bearer API/);
  });

  it('rejects the two surfaces binding different tenants for one shape', () => {
    const bad = replace('single-tenant', {
      platformApi: { kind: 'tenant-write', tenantId: 'tenant-b' },
    });
    expect(() => assertOidcClaimShapeContract(bad)).toThrow(/binds tenant/);
  });

  it('rejects a table trimmed until it proves nothing', () => {
    expect(() => assertOidcClaimShapeContract([])).toThrow(/empty/);
    const onlyBenign: Row[] = [
      {
        id: 'single-tenant',
        why: 'the only shape left after someone deleted the interesting rows',
        hostile: false,
        claims: { tenantIds: ['tenant-a'] },
        adminShell: { kind: 'tenant-write', tenantId: 'tenant-a' },
        platformApi: { kind: 'tenant-write', tenantId: 'tenant-a' },
      },
    ];
    expect(() => assertOidcClaimShapeContract(onlyBenign)).toThrow(/coverage floor/);
  });

  it('rejects duplicate ids and rows without an id', () => {
    const dup = clone((rows) => rows.push({ ...rows[0]! }));
    expect(() => assertOidcClaimShapeContract(dup)).toThrow(/duplicate id/);
    const anonymous = replace('no-flag-no-tenant', { id: '' });
    expect(() => assertOidcClaimShapeContract(anonymous)).toThrow(/stable id/);
  });
});

describe('oidc claim-shape contract: privilege lattice', () => {
  const P: OidcPrivilege = { kind: 'platform-write' };
  const TA: OidcPrivilege = { kind: 'tenant-write', tenantId: 'tenant-a' };
  const TB: OidcPrivilege = { kind: 'tenant-write', tenantId: 'tenant-b' };
  const R: OidcPrivilege = { kind: 'read-only' };
  const N: OidcPrivilege = { kind: 'none' };

  it('orders platform > tenant > read-only > none', () => {
    expect(dominatesOidcPrivilege(P, N)).toBe(true);
    expect(dominatesOidcPrivilege(P, TA)).toBe(true);
    expect(dominatesOidcPrivilege(TA, N)).toBe(true);
    expect(dominatesOidcPrivilege(TA, R)).toBe(true);
    expect(dominatesOidcPrivilege(R, N)).toBe(true);
    expect(dominatesOidcPrivilege(N, R)).toBe(false);
    expect(dominatesOidcPrivilege(R, TA)).toBe(false);
    expect(dominatesOidcPrivilege(TA, P)).toBe(false);
  });

  it('treats two tenant grants as equal only for the same tenant', () => {
    expect(dominatesOidcPrivilege(TA, TA)).toBe(true);
    expect(dominatesOidcPrivilege(TA, TB)).toBe(false);
    expect(dominatesOidcPrivilege(TB, TA)).toBe(false);
  });

  it('treats every privilege as dominating itself', () => {
    for (const p of [P, TA, TB, R, N]) {
      expect(dominatesOidcPrivilege(p, p)).toBe(true);
    }
  });
});
