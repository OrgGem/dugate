import {
  evaluateVaultAccess,
  vaultPolicyFor,
  VAULT_DEV_SCOPES,
  type VaultActor,
  type VaultCapability,
  type VaultPrefixScope,
} from '../../src/vault-policies';

/**
 * VAULT-02 dev fixture: deterministic, in-memory KV v2 engine behind a
 * policy-enforcing fake client. Belongs to the testing lane — repeatable boot
 * (fresh state + stable ids per call), virtual clock (no real timers), and the
 * SAME evaluateVaultAccess the deploy HCL is generated from. Models: versions
 * + CAS, metadata masking (values never leave data endpoints), token TTL /
 * renewal / revoke, and outage/timeout simulation whose errors are
 * retryable-flagged and value-free (SEC-05: never fall back to the legacy DB
 * secret on Vault failure).
 */

export type VaultOutageMode = 'off' | 'unavailable' | 'timeout';

export class VaultError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultToken {
  id: string;
  actor: VaultActor;
  expiresAtMs: number;
}

export interface VaultRefArgs {
  token: VaultToken;
  mount: string;
  path: string;
}

interface SecretVersion {
  version: number;
  data: Record<string, unknown>;
  createdAtMs: number;
}

export interface VaultDevFixtureOptions {
  nowMs?: number;
  tokenTtlMs?: number;
  scopes?: readonly VaultPrefixScope[];
}

export interface VaultDevFixture {
  clock(): number;
  advance(ms: number): void;
  setOutage(mode: VaultOutageMode): void;
  outage(): VaultOutageMode;
  login(actor: VaultActor): VaultToken;
  renew(tokenId: string): VaultToken;
  revoke(tokenId: string): void;
  write(args: VaultRefArgs & { key: string; value: unknown; cas?: number }): Promise<{ version: number }>;
  read(args: VaultRefArgs & { version?: number; key?: string }): Promise<{ data: Record<string, unknown>; version: number } | { value: unknown; version: number }>;
  readMetadata(args: VaultRefArgs): Promise<{ current_version: number; versions: Record<string, { created_time: number }> }>;
}

const SECRET_TOKENS_PREFIX = 'dev-token-';

export function createVaultDevFixture(options: VaultDevFixtureOptions = {}): VaultDevFixture {
  let nowMs = options.nowMs ?? 1_000;
  const ttlMs = options.tokenTtlMs ?? 120_000;
  const scopes = options.scopes ?? VAULT_DEV_SCOPES;
  const store = new Map<string, { versions: SecretVersion[] }>();
  const tokens = new Map<string, VaultToken & { revoked: boolean }>();
  const policies = new Map<VaultActor, ReturnType<typeof vaultPolicyFor>>();
  let outage: VaultOutageMode = 'off';
  let issued = 0;

  const pathOf = (mount: string, path: string): string => mount + '::' + path;
  const lastVersion = (versions: SecretVersion[]): SecretVersion | undefined =>
    versions.length > 0 ? versions[versions.length - 1] : undefined;
  const policyOf = (actor: VaultActor) => {
    let p = policies.get(actor);
    if (!p) {
      p = vaultPolicyFor(actor, scopes);
      policies.set(actor, p);
    }
    return p;
  };

  const guard = (token: VaultToken, capability: VaultCapability, mount: string, path: string): void => {
    if (outage === 'unavailable') {
      throw new VaultError('VAULT_UNAVAILABLE', 503, 'vault unavailable (retryable; no legacy fallback)', true);
    }
    if (outage === 'timeout') {
      throw new VaultError('VAULT_TIMEOUT', 504, 'vault timeout (retryable; no legacy fallback)', true);
    }
    const live = tokens.get(token.id);
    if (!live || live.revoked || live.actor !== token.actor || live.expiresAtMs !== token.expiresAtMs) {
      throw new VaultError('TOKEN_INVALID', 400, 'vault token invalid');
    }
    const decision = evaluateVaultAccess({
      policy: policyOf(live.actor),
      tokenActor: live.actor,
      tokenExpiresAtMs: live.expiresAtMs,
      nowMs,
      capability,
      mount,
      path,
    });
    if (decision.effect === 'deny') {
      throw new VaultError(decision.code ?? 'DENIED', 403, 'vault denied ' + capability + " on '" + mount + '/' + path + "'");
    }
  };

  const fixture: VaultDevFixture = {
    clock: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setOutage: (mode: VaultOutageMode) => {
      outage = mode;
    },
    outage: () => outage,

    login(actor: VaultActor): VaultToken {
      // Absolute prohibition gate BEFORE any path logic: workers and browsers
      // never receive a Vault token at all.
      const policy = policyOf(actor);
      if (!policy.hasVaultIdentity) {
        throw new VaultError('NO_VAULT_IDENTITY', 400, 'actor "' + actor + '" must never hold a Vault token');
      }
      issued += 1;
      const token: VaultToken & { revoked: boolean } = {
        id: SECRET_TOKENS_PREFIX + issued,
        actor,
        expiresAtMs: nowMs + ttlMs,
        revoked: false,
      };
      tokens.set(token.id, token);
      return token;
    },

    renew(tokenId: string): VaultToken {
      const live = tokens.get(tokenId);
      if (!live || live.revoked) {
        throw new VaultError('TOKEN_INVALID', 400, 'vault token invalid');
      }
      if (nowMs >= live.expiresAtMs) {
        // Expired tokens CANNOT be resurrected — the caller must re-login.
        throw new VaultError('TOKEN_EXPIRED', 403, 'vault token expired; re-authenticate');
      }
      live.expiresAtMs = nowMs + ttlMs;
      return live;
    },

    revoke(tokenId: string): void {
      const live = tokens.get(tokenId);
      if (live) live.revoked = true;
    },

    async write(args) {
      guard(args.token, 'write', args.mount, args.path);
      const k = pathOf(args.mount, args.path);
      const entry = store.get(k) ?? { versions: [] };
      const current = lastVersion(entry.versions)?.version ?? 0;
      if (args.cas !== undefined && args.cas !== current) {
        throw new VaultError('CAS_CONFLICT', 409, "check-and-set conflict on '" + args.mount + '/' + args.path + "'");
      }
      const version = current + 1;
      entry.versions.push({
        version,
        data: { ...lastVersion(entry.versions)?.data, [args.key]: args.value },
        createdAtMs: nowMs,
      });
      store.set(k, entry);
      return { version };
    },

    async read(args) {
      guard(args.token, 'read', args.mount, args.path);
      const entry = store.get(pathOf(args.mount, args.path));
      if (!entry || entry.versions.length === 0) {
        throw new VaultError('SECRET_NOT_FOUND', 404, "no secret at '" + args.mount + '/' + args.path + "'");
      }
      const wanted = args.version ?? lastVersion(entry.versions)?.version ?? 0;
      const found = entry.versions.find((v) => v.version === wanted);
      if (!found) {
        throw new VaultError('SECRET_VERSION_NOT_FOUND', 404, 'version not found');
      }
      if (args.key === undefined) return { data: { ...found.data }, version: found.version };
      if (!(args.key in found.data)) {
        throw new VaultError('KEY_NOT_FOUND', 404, "field '" + String(args.key) + "' not present");
      }
      return { value: found.data[args.key], version: found.version };
    },

    async readMetadata(args) {
      guard(args.token, 'metadata-read', args.mount, args.path);
      const entry = store.get(pathOf(args.mount, args.path));
      const versions: Record<string, { created_time: number }> = {};
      for (const v of entry?.versions ?? []) {
        versions[String(v.version)] = { created_time: v.createdAtMs };
      }
      // Metadata NEVER carries values — masking is structural, not a filter.
      return {
        current_version: lastVersion(entry?.versions ?? [])?.version ?? 0,
        versions,
      };
    },
  };
  return fixture;
}
