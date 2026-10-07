/**
 * VAULT-02 (tasks/SEC-OIDC-VAULT-2026-09-24.md): machine identities and
 * prefix-scoped capability policy for the Vault KV v2 provider credential
 * store, expressed as DATA so every consumer (fixture, deploy HCL, tests)
 * shares ONE source of truth.
 *
 * Trust model (SEC-00 matrix):
 *   - orchestrator-writer: create/update on its prefix + metadata reads for
 *     CAS version discovery. NEVER a plaintext read — the writer must not be
 *     able to see provider keys after writing them.
 *   - connector-reader: read + metadata-read on its prefix. NEVER write.
 *   - worker / browser: NO Vault identity at all. Any token they present is
 *     rejected before path evaluation — direct Vault access by a worker or a
 *     browser is forbidden absolutely, not by convention.
 *   - A denied decision must never leak the secret; every error path is
 *     capability/prefix-shaped and value-free by construction.
 */

export const VAULT_ACTORS = ['orchestrator-writer', 'connector-reader', 'worker', 'browser'] as const;
export type VaultActor = (typeof VAULT_ACTORS)[number];

export const VAULT_CAPABILITIES = ['read', 'write', 'metadata-read'] as const;
export type VaultCapability = (typeof VAULT_CAPABILITIES)[number];

export interface VaultPrefixScope {
  /** KV v2 mount, e.g. 'secret'. */
  mount: string;
  /** '/'-joined path prefix INSIDE the mount, e.g. 'du/connector'. */
  pathPrefix: string;
}

/** SEC-00 default for dev/test; an ADR may tighten or rename the prefix. */
export const VAULT_DEV_SCOPES: readonly VaultPrefixScope[] = Object.freeze([
  { mount: 'secret', pathPrefix: 'du/connector' },
]);

export interface VaultPrincipalPolicy {
  actor: VaultActor;
  hasVaultIdentity: boolean;
  capabilities: readonly VaultCapability[];
  scopes: readonly VaultPrefixScope[];
}

export function vaultPolicyFor(
  actor: VaultActor,
  scopes: readonly VaultPrefixScope[] = VAULT_DEV_SCOPES,
): VaultPrincipalPolicy {
  switch (actor) {
    case 'orchestrator-writer':
      return { actor, hasVaultIdentity: true, capabilities: ['write', 'metadata-read'], scopes };
    case 'connector-reader':
      return { actor, hasVaultIdentity: true, capabilities: ['read', 'metadata-read'], scopes };
    default:
      // worker | browser (and anything unknown): fail closed, no identity.
      return { actor, hasVaultIdentity: false, capabilities: [], scopes: [] };
  }
}

export type VaultDenyCode =
  | 'NO_VAULT_IDENTITY'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'CAPABILITY_DENIED'
  | 'PREFIX_DENIED';

export interface VaultAccessDecision {
  effect: 'allow' | 'deny';
  code?: VaultDenyCode;
}

export interface VaultAccessInput {
  policy: VaultPrincipalPolicy;
  /** The presented token's actor claim — must equal policy.actor (impersonation guard). */
  tokenActor: VaultActor;
  tokenExpiresAtMs: number;
  nowMs: number;
  capability: VaultCapability;
  mount: string;
  path: string;
}

function inScope(scope: VaultPrefixScope, mount: string, path: string): boolean {
  // Vault normalises paths at its HTTP boundary. Reject traversal segments
  // here as well so the offline policy cannot accidentally widen a tenant or
  // account prefix when it is used by a client or deployment harness.
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  return scope.mount === mount && (path === scope.pathPrefix || path.startsWith(scope.pathPrefix + '/'));
}

/** Pure decision function — evaluation ORDER is the security contract. */
export function evaluateVaultAccess(input: VaultAccessInput): VaultAccessDecision {
  if (!input.policy.hasVaultIdentity || input.tokenActor !== input.policy.actor) {
    return { effect: 'deny', code: 'NO_VAULT_IDENTITY' };
  }
  if (input.nowMs >= input.tokenExpiresAtMs) {
    return { effect: 'deny', code: 'TOKEN_EXPIRED' };
  }
  if (!input.policy.capabilities.includes(input.capability)) {
    return { effect: 'deny', code: 'CAPABILITY_DENIED' };
  }
  if (!input.policy.scopes.some((s) => inScope(s, input.mount, input.path))) {
    return { effect: 'deny', code: 'PREFIX_DENIED' };
  }
  return { effect: 'allow' };
}

/** Deterministic deployable HCL for the given actor (infra/vault/policies). */
export function renderVaultPolicyHcl(
  actor: VaultActor,
  scopes: readonly VaultPrefixScope[] = VAULT_DEV_SCOPES,
): string {
  const policy = vaultPolicyFor(actor, scopes);
  const lines: string[] = [];
  lines.push('# VAULT-02 machine identity: ' + actor);
  if (!policy.hasVaultIdentity) {
    lines.push('# NO Vault access: this actor must never hold or exchange Vault tokens.');
    return lines.join('\n') + '\n';
  }
  lines.push('# AppRole/Kubernetes auth only — never the root token (SEC-04/07).');
  for (const scope of policy.scopes) {
    const root = scope.mount + '/';
    if (policy.capabilities.includes('write')) {
      lines.push(
        'path "' + root + 'data/' + scope.pathPrefix + '/*" {',
        '  capabilities = ["create", "update"]',
        '}',
      );
    }
    if (policy.capabilities.includes('read')) {
      lines.push(
        'path "' + root + 'data/' + scope.pathPrefix + '/*" {',
        '  capabilities = ["read"]',
        '}',
      );
    }
    if (policy.capabilities.includes('metadata-read')) {
      const caps = policy.capabilities.includes('write') ? '["read", "list"]' : '["read"]';
      lines.push(
        'path "' + root + 'metadata/' + scope.pathPrefix + '/*" {',
        '  capabilities = ' + caps,
        '}',
      );
    }
  }
  if (actor === 'orchestrator-writer') {
    lines.push('# No "read" capability on any data path: the writer never sees plaintext.');
  } else {
    lines.push('# No create/update capability anywhere: the reader cannot mutate or rotate.');
  }
  return lines.join('\n') + '\n';
}
