/**
 * OIDC claim-shape contract (SEC; Reviewer Turn 40 finding "SEC claim-shape
 * consistency").
 *
 * WHY THIS FILE EXISTS. Two trust surfaces read the SAME verified id_token
 * claims and each has its own default-deny mapper:
 *   - Admin shell (browser session): roleFor() in services/orchestrator
 *     src/app/admin/oidc-flow.ts maps claims -> a minted session role.
 *   - Platform API (server bearer): mapOidcClaimsToPrincipal() in
 *     services/orchestrator src/modules/admin-actions/rbac.ts maps the same
 *     claims -> a trusted admin principal.
 * They intentionally DIVERGE on exactly one shape (a subject with more than
 * one tenant: the browser mints a least-privilege read-only session, the
 * bearer API mints no principal at all). That divergence was previously
 * only described in prose, so a later "unify the two mappers" refactor
 * could flip either side with a fully green test tree. This file is the
 * machine-checkable form of the decision, so the check lives in CI and not
 * in a comment.
 *
 * ADR — the rule the assertion enforces: for every claim shape, the bearer
 * surface must never grant MORE than the browser surface.
 *   - The browser surface is the least-privilege anchor: anything it grants
 *     a human, the server-to-server API may also do.
 *   - Therefore `platformApi` must be dominated by `adminShell` for every
 *     entry. Broadening the bearer mapper (multi-tenant -> tenant_operator,
 *     a loose claim type -> a real tenant id) breaks this assertion.
 *   - The converse is allowed on purpose: the browser may hand a human a
 *     read-only viewer session where the bearer API hands out nothing. Read
 *     access to one's own shell is not a privilege the platform API needs
 *     to expose to a token, and the two responses are not interchangeable
 *     (a minted session vs. no principal), so we do NOT force them equal.
 *   - Hostile shapes (wrong types where a well-formed value is expected)
 *     must yield NO privilege on either surface. TypeScript's
 *     `tenantIds?: string[]` is a compile-time fiction: the value is JSON
 *     out of a verified JWT, so the runtime shape is untrusted and is
 *     asserted here rather than assumed.
 *
 * SCOPE. This contract covers claim SHAPE -> privilege. It does not cover
 * issuer allowlisting, signature/alg verification, nonce or exp handling
 * (SEC-01 oidc-client), nor session storage (OIDC-02). Those are enforced
 * before a claim set reaches either mapper.
 *
 * HOW IT IS ENFORCED. `assertOidcClaimShapeContract()` is called by the
 * contracts suite over this table, and services/orchestrator/tests/
 * oidc-claim-shape-contract-offline.test.ts re-derives the same invariant
 * from the LIVE output of both mappers, so editing this table to match a
 * widened mapper still fails the orchestrator suite.
 */

/** Privilege a surface can grant for one claim shape, ordered
 *  none < read-only < tenant-write(tenant) < platform-write. */
export type OidcPrivilege =
  | { readonly kind: 'none' }
  | { readonly kind: 'read-only' }
  | { readonly kind: 'tenant-write'; readonly tenantId: string }
  | { readonly kind: 'platform-write' };

export interface OidcClaimShapeEntry {
  /** stable id; the assertion messages quote it so CI output is actionable. */
  readonly id: string;
  /** why this shape exists / why it maps the way it does. */
  readonly why: string;
  /** A shape that must never yield write privilege on either surface. */
  readonly hostile: boolean;
  /** The shape-defining claims only. `sub`/`iss` are identity, not shape;
   *  a caller supplies them from its own trusted context. */
  readonly claims: Readonly<Record<string, unknown>>;
  /** Privilege the Admin shell mints a session for. */
  readonly adminShell: OidcPrivilege;
  /** Privilege the Platform API mints a bearer principal for. */
  readonly platformApi: OidcPrivilege;
}

const NONE: OidcPrivilege = { kind: 'none' };
const READ_ONLY: OidcPrivilege = { kind: 'read-only' };
const PLATFORM: OidcPrivilege = { kind: 'platform-write' };
const TENANT_A: OidcPrivilege = { kind: 'tenant-write', tenantId: 'tenant-a' };

/**
 * The pinned claim-shape table. Rows are the two well-formed shapes, the one
 * deliberate divergence, and the hostile shapes that must stay inert.
 */
export const OIDC_CLAIM_SHAPE_CONTRACT: readonly OidcClaimShapeEntry[] = [
  {
    id: 'platform-admin-boolean',
    why: 'Platform group membership: the only claim that grants platform-wide write on both surfaces.',
    hostile: false,
    claims: { platformAdmin: true },
    adminShell: PLATFORM,
    platformApi: PLATFORM,
  },
  {
    id: 'single-tenant',
    why: 'Exactly one tenant: the only shape that grants tenant-scoped write, and both surfaces must bind the SAME tenant id.',
    hostile: false,
    claims: { tenantIds: ['tenant-a'] },
    adminShell: TENANT_A,
    platformApi: TENANT_A,
  },
  {
    id: 'multi-tenant-deliberate-divergence',
    why: 'DELIBERATE: a real multi-tenant human gets a read-only viewer session on the browser surface and NO principal on the bearer surface. Per-tenant selection does not exist yet, so neither surface may guess which tenant the caller meant; the browser still gets a usable read-only shell. Do not "fix" this by making the bearer API pick tenant[0].',
    hostile: false,
    claims: { tenantIds: ['tenant-a', 'tenant-b'] },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'no-flag-no-tenant',
    why: 'Authenticated subject with no group and no tenant: identity without authority.',
    hostile: false,
    claims: {},
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'empty-tenant-array',
    why: 'Tenant claim present but empty: an attempt to claim tenancy with nothing to bind.',
    hostile: true,
    claims: { tenantIds: [] },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'platform-admin-string',
    why: 'platformAdmin sent as the string "true" (loose IdP mapping). Only the boolean grants platform; a string must not be coerced.',
    hostile: true,
    claims: { platformAdmin: 'true' },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'platform-admin-number',
    why: 'platformAdmin sent as 1. Truthy but not the boolean true.',
    hostile: true,
    claims: { platformAdmin: 1 },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'platform-admin-object',
    why: 'platformAdmin sent as an object wrapping the boolean. Truthy, not the boolean true.',
    hostile: true,
    claims: { platformAdmin: { value: true } },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'tenant-ids-not-an-array',
    why: 'tenantIds sent as a bare string instead of an array.',
    hostile: true,
    claims: { tenantIds: 'tenant-a' },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'tenant-member-not-a-string',
    why: 'tenantIds array whose single member is a number. A non-string tenant id can never match a stored tenant, so granting a principal on it is a latent escalation path if any comparison ever coerces.',
    hostile: true,
    claims: { tenantIds: [42] },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'tenant-member-empty-string',
    why: 'tenantIds array whose single member is empty. Same latent path as a non-string member: the id is present but binds to no tenant.',
    hostile: true,
    claims: { tenantIds: [''] },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
  {
    id: 'tenant-array-with-empty-member',
    why: 'Two members, one of them empty: length-based checks must not treat this as a single usable tenant.',
    hostile: true,
    claims: { tenantIds: ['tenant-a', ''] },
    adminShell: READ_ONLY,
    platformApi: NONE,
  },
];

function rank(p: OidcPrivilege): number {
  switch (p.kind) {
    case 'platform-write':
      return 3;
    case 'tenant-write':
      return 2;
    case 'read-only':
      return 1;
    case 'none':
      return 0;
  }
}

/** True when `granted` is at least as privileged as `baseline`. Two
 *  tenant-write privileges dominate each other only for the SAME tenant. */
export function dominatesOidcPrivilege(granted: OidcPrivilege, baseline: OidcPrivilege): boolean {
  const rg = rank(granted);
  const rb = rank(baseline);
  if (rg !== rb) return rg > rb;
  if (granted.kind === 'tenant-write' && baseline.kind === 'tenant-write') {
    return granted.tenantId === baseline.tenantId;
  }
  return true;
}

/** Floor that keeps the assertion from being made vacuous by deleting rows:
 *  one of each privilege kind plus the hostile class must be present. */
const MIN_PLATFORM = 1;
const MIN_TENANT = 1;
const MIN_READ_ONLY = 1;
const MIN_HOSTILE = 1;

/**
 * Throws when the table violates the ADR above. Pure and dependency-free so
 * it can run in the contracts package (table self-consistency) and in the
 * orchestrator (re-derived from live mapper output).
 */
export function assertOidcClaimShapeContract(
  entries: readonly OidcClaimShapeEntry[] = OIDC_CLAIM_SHAPE_CONTRACT
): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('oidc claim-shape contract: table is empty');
  }
  const seen = new Set<string>();
  let platform = 0;
  let tenant = 0;
  let readOnly = 0;
  let hostile = 0;

  for (const e of entries) {
    if (typeof e.id !== 'string' || e.id.length === 0) {
      throw new Error('oidc claim-shape contract: entry without a stable id');
    }
    if (seen.has(e.id)) {
      throw new Error('oidc claim-shape contract: duplicate id ' + e.id);
    }
    seen.add(e.id);

    // Tenant agreement is checked BEFORE the ordering rule on purpose: two
    // same-rank grants naming different tenants are a more specific fault
    // than "the API outranks the shell", and the more specific message is
    // the one a future refactor author needs. (Checked second, this branch
    // is unreachable — same rank, different tenant, already fails ordering.)
    if (
      e.adminShell.kind === 'tenant-write' &&
      e.platformApi.kind === 'tenant-write' &&
      e.adminShell.tenantId !== e.platformApi.tenantId
    ) {
      throw new Error(
        'oidc claim-shape contract: ' +
          e.id +
          ' binds tenant ' +
          e.adminShell.tenantId +
          ' on the shell but ' +
          e.platformApi.tenantId +
          ' on the API'
      );
    }
    // ADR rule: the bearer surface never outranks the browser surface.
    if (!dominatesOidcPrivilege(e.adminShell, e.platformApi)) {
      throw new Error(
        'oidc claim-shape contract: ' +
          e.id +
          ' grants the bearer API (' +
          e.platformApi.kind +
          ') more than the admin shell (' +
          e.adminShell.kind +
          ') — the API surface may only be equal or stricter'
      );
    }
    if (e.hostile) {
      if (e.platformApi.kind !== 'none') {
        throw new Error(
          'oidc claim-shape contract: hostile shape ' + e.id + ' grants a bearer principal'
        );
      }
      if (e.adminShell.kind !== 'read-only' && e.adminShell.kind !== 'none') {
        throw new Error(
          'oidc claim-shape contract: hostile shape ' + e.id + ' grants shell write privilege'
        );
      }
      hostile += 1;
    }
    if (e.adminShell.kind === 'platform-write' || e.platformApi.kind === 'platform-write') platform += 1;
    if (e.adminShell.kind === 'tenant-write' || e.platformApi.kind === 'tenant-write') tenant += 1;
    if (e.adminShell.kind === 'read-only') readOnly += 1;
  }

  const missing: string[] = [];
  if (platform < MIN_PLATFORM) missing.push('platform-write');
  if (tenant < MIN_TENANT) missing.push('tenant-write');
  if (readOnly < MIN_READ_ONLY) missing.push('read-only');
  if (hostile < MIN_HOSTILE) missing.push('hostile');
  if (missing.length > 0) {
    throw new Error(
      'oidc claim-shape contract: coverage floor not met for ' + missing.join(', ')
    );
  }
}
