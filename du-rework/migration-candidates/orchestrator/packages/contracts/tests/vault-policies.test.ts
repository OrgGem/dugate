import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateVaultAccess,
  renderVaultPolicyHcl,
  vaultPolicyFor,
  VAULT_ACTORS,
  VAULT_DEV_SCOPES,
  type VaultActor,
  type VaultCapability,
  type VaultPrefixScope,
} from '../src/vault-policies';
import {
  ConnectorCredentialSourceSchema,
  matchesVaultAccountPath,
  matchesVaultRevisionBinding,
  VaultKv2RefSchema,
} from '../src/vault';
import { createVaultDevFixture, VaultError, type VaultDevFixture } from './stubs/vault-dev-fixture';

/**
 * VAULT-02 offline policy tests (Qwen-2, cycle 95) — zero DB/Redis/network.
 * Proves: writer read-denied / reader write-denied on the right prefix,
 * wrong-prefix denied, worker/browser absolute denial, token renewal/expiry,
 * outage fail-closed without leaking values, and repeatable fixture boot.
 */

const SECRET = 'sk-live-VaultFixtureSentinel-a1b2c3';
const ALLOW = { mount: 'secret', path: 'du/connector/openai/prod' };
const DENIED_PATH = { mount: 'secret', path: 'tenant-sandbox/other' };

function decision(
  actor: VaultActor,
  capability: VaultCapability,
  opts: { mount?: string; path?: string; expired?: boolean } = {},
) {
  const nowMs = 1_000;
  return evaluateVaultAccess({
    policy: vaultPolicyFor(actor, VAULT_DEV_SCOPES),
    tokenActor: actor,
    tokenExpiresAtMs: opts.expired ? 500 : 5_000,
    nowMs,
    capability,
    mount: opts.mount ?? ALLOW.mount,
    path: opts.path ?? ALLOW.path,
  });
}

describe('evaluateVaultAccess — capability matrix', () => {
  it('writer: write+metadata allowed, plaintext read DENIED', () => {
    expect(decision('orchestrator-writer', 'write').effect).toBe('allow');
    expect(decision('orchestrator-writer', 'metadata-read').effect).toBe('allow');
    expect(decision('orchestrator-writer', 'read')).toEqual({ effect: 'deny', code: 'CAPABILITY_DENIED' });
  });

  it('reader: read+metadata allowed, write DENIED', () => {
    expect(decision('connector-reader', 'read').effect).toBe('allow');
    expect(decision('connector-reader', 'metadata-read').effect).toBe('allow');
    expect(decision('connector-reader', 'write')).toEqual({ effect: 'deny', code: 'CAPABILITY_DENIED' });
  });

  it.each(['read', 'write', 'metadata-read'] as VaultCapability[])(
    'worker is denied %s absolutely (no identity)',
    (cap) => {
      expect(decision('worker', cap)).toEqual({ effect: 'deny', code: 'NO_VAULT_IDENTITY' });
    },
  );
  it.each(['read', 'write', 'metadata-read'] as VaultCapability[])(
    'browser is denied %s absolutely (no identity)',
    (cap) => {
      expect(decision('browser', cap)).toEqual({ effect: 'deny', code: 'NO_VAULT_IDENTITY' });
    },
  );

  it('expired token denies before capability/prefix logic', () => {
    expect(decision('connector-reader', 'read', { expired: true })).toEqual({ effect: 'deny', code: 'TOKEN_EXPIRED' });
    expect(decision('orchestrator-writer', 'write', { expired: true })).toEqual({ effect: 'deny', code: 'TOKEN_EXPIRED' });
  });

  it('prefix and mount scoping', () => {
    expect(decision('connector-reader', 'read', { path: DENIED_PATH.path })).toEqual({
      effect: 'deny',
      code: 'PREFIX_DENIED',
    });
    expect(decision('orchestrator-writer', 'write', { mount: 'other-mount' })).toEqual({
      effect: 'deny',
      code: 'PREFIX_DENIED',
    });
    // boundary guard: prefix must be a full segment, not a string prefix
    expect(decision('connector-reader', 'read', { path: 'du/connector_evil/x' })).toEqual({
      effect: 'deny',
      code: 'PREFIX_DENIED',
    });
  });
});

describe('dev fixture — end-to-end policy enforcement', () => {
  let fx: VaultDevFixture;
  beforeEach(() => {
    fx = createVaultDevFixture({ nowMs: 1_000, tokenTtlMs: 120_000 });
  });

  it('worker/browser can never even log in', () => {
    expect(() => fx.login('worker')).toThrow(/NO_VAULT_IDENTITY|must never hold/);
    expect(() => fx.login('browser')).toThrow();
    try {
      fx.login('worker');
    } catch (e) {
      expect((e as VaultError).code).toBe('NO_VAULT_IDENTITY');
    }
  });

  it('writer writes; reader reads the SAME pinned version; neither crosses capabilities', async () => {
    const writer = fx.login('orchestrator-writer');
    const reader = fx.login('connector-reader');

    const w = await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: SECRET });
    expect(w.version).toBe(1);

    await expect(fx.read({ ...ALLOW, token: writer, key: 'api-key' })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      httpStatus: 403,
    });
    const r = await fx.read({ ...ALLOW, token: reader, version: 1, key: 'api-key' });
    expect((r as { value: unknown }).value).toBe(SECRET);
    await expect(fx.write({ ...ALLOW, token: reader, key: 'api-key', value: 'x' })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      httpStatus: 403,
    });
  });

  it('wrong prefix and foreign mount are denied without touching the store', async () => {
    const writer = fx.login('orchestrator-writer');
    await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: SECRET });
    const reader = fx.login('connector-reader');
    await expect(fx.read({ mount: 'secret', path: 'du/others/x', token: reader, key: 'api-key' })).rejects.toMatchObject({
      code: 'PREFIX_DENIED',
    });
    await expect(fx.write({ mount: 'kv-prod', path: 'du/connector/x', token: writer, key: 'api-key', value: 'x' })).rejects.toMatchObject({
      code: 'PREFIX_DENIED',
    });
  });

  it('CAS: stale write conflicts; old versions stay immutable pins', async () => {
    const writer = fx.login('orchestrator-writer');
    await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: 'v1-secret' });
    const ok = await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: 'v2-secret', cas: 1 });
    expect(ok.version).toBe(2);
    await expect(fx.write({ ...ALLOW, token: writer, key: 'api-key', value: 'x', cas: 1 })).rejects.toMatchObject({
      code: 'CAS_CONFLICT',
      httpStatus: 409,
    });
    const reader = fx.login('connector-reader');
    const pinned = await fx.read({ ...ALLOW, token: reader, version: 1, key: 'api-key' });
    expect((pinned as { value: unknown }).value).toBe('v1-secret'); // rotation never mutates history
  });

  it('metadata endpoint is value-free (masking is structural)', async () => {
    const writer = fx.login('orchestrator-writer');
    await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: SECRET });
    const mdWriter = await fx.readMetadata({ ...ALLOW, token: writer });
    const reader = fx.login('connector-reader');
    const mdReader = await fx.readMetadata({ ...ALLOW, token: reader });
    expect(mdWriter.current_version).toBe(1);
    expect(JSON.stringify(mdWriter) + JSON.stringify(mdReader)).not.toContain(SECRET);
  });

  it('renewal extends the session; expired tokens die and cannot be revived', async () => {
    const reader = fx.login('connector-reader');
    fx.advance(61_000);
    const renewed = fx.renew(reader.id);
    fx.advance(61_000); // 122s since renew? total 122 from issue, 61 from renew → still alive
    // policy passed (renewal extended the session); store entry absent by design
    await expect(fx.read({ ...ALLOW, token: renewed, key: 'api-key' })).rejects.toMatchObject({
      code: 'SECRET_NOT_FOUND',
    });
    fx.advance(60_000); // past renew+120s
    await expect(fx.read({ ...ALLOW, token: renewed, key: 'api-key' })).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(() => fx.renew(renewed.id)).toThrow(/expired; re-authenticate/);
  });

  it('revoked tokens are TOKEN_INVALID for every operation', async () => {
    const reader = fx.login('connector-reader');
    fx.revoke(reader.id);
    await expect(fx.read({ ...ALLOW, token: reader, key: 'api-key' })).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('outage modes fail CLOSED (retryable, value-free, no fallback field)', async () => {
    const writer = fx.login('orchestrator-writer');
    await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: SECRET });
    const reader = fx.login('connector-reader');

    fx.setOutage('unavailable');
    await expect(fx.read({ ...ALLOW, token: reader, key: 'api-key' })).rejects.toMatchObject({
      code: 'VAULT_UNAVAILABLE',
      retryable: true,
    });
    fx.setOutage('timeout');
    await expect(fx.read({ ...ALLOW, token: reader, key: 'api-key' })).rejects.toMatchObject({
      code: 'VAULT_TIMEOUT',
      retryable: true,
    });
    fx.setOutage('off');
    const back = await fx.read({ ...ALLOW, token: reader, key: 'api-key' });
    expect((back as { value: unknown }).value).toBe(SECRET);
  });

  it('fixture boots repeatably: fresh state + deterministic ids across boots', async () => {
    const a = createVaultDevFixture();
    const b = createVaultDevFixture();
    const ta = a.login('orchestrator-writer');
    const tb = b.login('orchestrator-writer');
    expect(ta.id).toBe(tb.id); // deterministic id sequence per boot
    await a.write({ ...ALLOW, token: ta, key: 'api-key', value: 'in-a' });
    const rb = b.login('connector-reader');
    await expect(b.read({ ...ALLOW, token: rb, key: 'api-key' })).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });

  it('deny/outage error messages never carry the secret value', async () => {
    const writer = fx.login('orchestrator-writer');
    await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: SECRET });
    const reader = fx.login('connector-reader');
    const errs: unknown[] = [];
    fx.setOutage('timeout');
    await fx.read({ ...ALLOW, token: reader, key: 'api-key' }).catch((e: unknown) => errs.push(e));
    fx.setOutage('off');
    await fx.write({ ...ALLOW, token: reader, key: 'api-key', value: SECRET }).catch((e: unknown) => errs.push(e));
    await fx.read({ mount: 'secret', path: 'du/x/y', token: reader, key: 'api-key' }).catch((e: unknown) => errs.push(e));
    const dump = JSON.stringify(errs.map((e) => ({ code: (e as VaultError).code, message: (e as Error).message })));
    expect(dump).not.toContain(SECRET);
  });
});

describe('renderVaultPolicyHcl', () => {
  it('writer HCL grants create/update + metadata read, never data read', () => {
    const hcl = renderVaultPolicyHcl('orchestrator-writer');
    expect(hcl).toContain('path "secret/data/du/connector/*"');
    expect(hcl).toContain('["create", "update"]');
    expect(hcl).toContain('path "secret/metadata/du/connector/*"');
    expect(hcl).toContain('["read", "list"]');
    expect(hcl).not.toContain('capabilities = ["read"]\n}');
  });

  it('reader HCL grants data read only; worker/browser render no access', () => {
    const hcl = renderVaultPolicyHcl('connector-reader');
    expect(hcl).toContain('capabilities = ["read"]');
    expect(hcl).not.toContain('"create"');
    expect(renderVaultPolicyHcl('worker')).toContain('NO Vault access');
    expect(renderVaultPolicyHcl('browser')).toContain('NO Vault access');
  });
});

/**
 * W-VAULT-POLICY-CANONICAL-1 (Qwen-Vault, 2026-09-26): the ONLY canonical KV
 * path is the exact 7-segment shape du/tenants/<t>/connectors/<c>/accounts/<a>
 * (mount + 'data/' are separate wire layers and must never appear inside the
 * path field). matchesVaultAccountPath runs on CANDIDATE refs that may not
 * have passed through the schema layer yet, so it must fail closed on
 * traversal, foreign bindings and non-canonical aliases on its own — the
 * schema refinements stay as a second, independent layer (defense in depth).
 */
const CANON = {
  tenantId: 'tenant-a',
  connectorId: 'openai',
  accountId: 'du-conn-openai-main',
};
const CANON_PATH =
  'du/tenants/' + CANON.tenantId + '/connectors/' + CANON.connectorId + '/accounts/' + CANON.accountId;
const CANON_SCOPE = { tenantId: CANON.tenantId, connectorId: CANON.connectorId };

describe('matchesVaultAccountPath — canonical structure is the only accepted shape', () => {
  it('accepts exactly the 7-segment canonical path (read scope and binding-only scope)', () => {
    expect(matchesVaultAccountPath({ account: CANON.accountId, path: CANON_PATH }, CANON_SCOPE)).toBe(true);
    // write path: tenant anchoring comes from the stored binding, scope.tenantId optional
    expect(matchesVaultAccountPath({ account: CANON.accountId, path: CANON_PATH }, { connectorId: CANON.connectorId })).toBe(true);
  });

  it.each([
    ['5-segment shortcut without the connectors segment', 'du/tenants/' + CANON.tenantId + '/accounts/' + CANON.accountId],
    ['extra <rest> segments after the account', CANON_PATH + '/nested'],
    ['mount folded into the path (secret/data/...)', 'secret/data/' + CANON_PATH],
    ['vault data/ API prefix kept inside the path', 'data/' + CANON_PATH],
    ['leading slash', '/' + CANON_PATH],
    ['case-folded structural keywords', 'DU/Tenants/' + CANON.tenantId + '/Connectors/' + CANON.connectorId + '/Accounts/' + CANON.accountId],
    ['legacy dev-policy prefix shape', 'du/connector/openai/prod'],
  ])('rejects non-canonical alias: %s', (_label, path) => {
    expect(matchesVaultAccountPath({ account: CANON.accountId, path }, CANON_SCOPE)).toBe(false);
  });
});

describe('matchesVaultAccountPath — traversal fails closed on an UNVALIDATED ref', () => {
  it.each([
    ['dotdot at tenant position', 'du/tenants/../connectors/openai/accounts/' + CANON.accountId, CANON.accountId],
    ['dot-only at tenant position', 'du/tenants/./connectors/openai/accounts/' + CANON.accountId, CANON.accountId],
    ['dotdot at connector position', 'du/tenants/' + CANON.tenantId + '/connectors/../accounts/' + CANON.accountId, CANON.accountId],
    ['dotdot at account position (ref.account = ..)', CANON_PATH.replace(CANON.accountId, '..'), '..'],
    ['dot-only at account position (ref.account = .)', CANON_PATH.replace(CANON.accountId, '.'), '.'],
    ['leading ../../ escape', '../../' + CANON_PATH, CANON.accountId],
    ['trailing ../ escape', CANON_PATH + '/../etc', CANON.accountId],
    ['percent-encoded dots at tenant position', 'du/tenants/%2e%2e/connectors/openai/accounts/' + CANON.accountId, CANON.accountId],
  ])('rejects %s', (_label, path, account) => {
    expect(matchesVaultAccountPath({ account, path }, CANON_SCOPE)).toBe(false);
  });

  it('rejects a foreign tenant/account even when the id fields echo the path', () => {
    const foreign = 'du/tenants/tenant-b/connectors/openai/accounts/acct-b';
    expect(matchesVaultAccountPath({ account: 'acct-b', path: foreign }, CANON_SCOPE)).toBe(false);
    expect(matchesVaultAccountPath({ account: CANON.accountId, path: CANON_PATH }, { tenantId: 'tenant-b', connectorId: CANON.connectorId })).toBe(false);
    expect(matchesVaultAccountPath({ account: 'other-account', path: CANON_PATH }, CANON_SCOPE)).toBe(false);
    expect(matchesVaultAccountPath({ account: CANON.accountId, path: CANON_PATH }, { tenantId: CANON.tenantId, connectorId: 'anthropic' })).toBe(false);
  });

  it('the schema layer independently rejects .. substrings before matching (second line of defense)', () => {
    expect(
      VaultKv2RefSchema.safeParse({
        account: CANON.accountId,
        mount: 'secret',
        path: 'du/tenants/../connectors/openai/accounts/' + CANON.accountId,
        key: 'api-key',
      }).success,
    ).toBe(false);
  });
});

describe('evaluateVaultAccess — traversal cannot walk out of a granted prefix', () => {
  it('denies dot/dotdot segments even when the string still starts with the prefix', () => {
    expect(decision('connector-reader', 'read', { path: 'du/connector/protected/../../evil' })).toEqual({
      effect: 'deny',
      code: 'PREFIX_DENIED',
    });
    expect(decision('connector-reader', 'read', { path: 'du/connector/./openai/prod' })).toEqual({
      effect: 'deny',
      code: 'PREFIX_DENIED',
    });
    expect(decision('orchestrator-writer', 'write', { path: 'du/connector/x/../../..' })).toEqual({
      effect: 'deny',
      code: 'PREFIX_DENIED',
    });
  });

  it('legit segments merely CONTAINING dots stay allowed (check targets dot-segments, not ids)', () => {
    expect(decision('connector-reader', 'read', { path: 'du/connector/x..y/v1.2' })).toEqual({ effect: 'allow' });
  });
});

describe('credential-source alias normalization never relaxes the canonical path', () => {
  const vaultSource = (kind: string, path: string) => ({
    kind,
    account: CANON.accountId,
    mount: 'secret',
    path,
    key: 'api-key',
    version: 3,
  });

  it("legacy 'vault-kv-v2' alias canonicalizes to 'vault-kv2' with the path untouched", () => {
    const r = ConnectorCredentialSourceSchema.safeParse(vaultSource('vault-kv-v2', CANON_PATH));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ kind: 'vault-kv2', path: CANON_PATH });
  });

  it('alias kind is not a bypass: binding match still decides on the path itself', () => {
    expect(matchesVaultRevisionBinding(vaultSource('vault-kv-v2', CANON_PATH), CANON)).toBe(true);
    expect(
      matchesVaultRevisionBinding(vaultSource('vault-kv-v2', CANON_PATH.replace(CANON.tenantId, 'tenant-b')), CANON),
    ).toBe(false);
    expect(matchesVaultRevisionBinding(vaultSource('vault-kv2', CANON_PATH), { ...CANON, accountId: 'acct-other' })).toBe(false);
  });

  it('alias carrying a non-canonical or traversal path is rejected end-to-end', () => {
    expect(
      matchesVaultRevisionBinding(vaultSource('vault-kv-v2', 'du/tenants/' + CANON.tenantId + '/accounts/' + CANON.accountId), CANON),
    ).toBe(false);
    expect(
      matchesVaultRevisionBinding(vaultSource('vault-kv-v2', 'du/tenants/../connectors/openai/accounts/' + CANON.accountId), CANON),
    ).toBe(false);
  });
});

/**
 * W-VAULT-POLICY-HCL-IDENTITY-1 (Qwen-Vault, 2026-09-26): renderVaultPolicyHcl
 * is the single source of truth for the DEPLOYED machine-identity policies
 * under infra/vault/policies/. These tests PARSE the rendered HCL into path
 * blocks + capability sets (structural pinning) instead of substring probing,
 * so a widened, reordered or leaked capability block cannot render green.
 * Pinned matrix: writer = create/update on data + read/list on metadata and
 * NEVER a plaintext read; reader = read on data + metadata and NEVER any
 * non-read capability; worker/browser = zero rendered capability (fail closed).
 */
const HCL_VALID_CAPS = new Set(['read', 'create', 'update', 'patch', 'delete', 'list', 'sudo', 'deny']);

interface HclBlock {
  path: string;
  capabilities: string[];
}

function parseHclBlocks(hcl: string): { blocks: HclBlock[]; invalid: string[] } {
  const blocks: HclBlock[] = [];
  const invalid: string[] = [];
  let quotes = 0;
  let braces = 0;
  let openPath: string | null = null;
  hcl.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    quotes += (raw.match(/"/g) ?? []).length;
    for (const ch of raw) {
      if (ch === '{') braces += 1;
      else if (ch === '}') braces -= 1;
    }
    if (braces < 0) invalid.push(`line ${idx + 1}: closing brace without opener`);
    if (line === '' || line.startsWith('#')) return;
    if (openPath === null) {
      const header = /^path "(.+)" \{$/.exec(line);
      if (header === null || header[1] === undefined) invalid.push(`line ${idx + 1}: unexpected top-level line: ${line}`);
      else openPath = header[1];
      return;
    }
    if (line === '}') {
      openPath = null;
      return;
    }
    const body = /^capabilities = \[([^\]]*)\]$/.exec(line);
    if (body === null) {
      invalid.push(`line ${idx + 1}: block body must be a capabilities list: ${line}`);
      return;
    }
    const caps: string[] = [];
    const list = (body[1] ?? '').trim();
    if (list !== '') {
      for (const item of list.split(',')) {
        const token = /^"([a-z]+)"$/.exec(item.trim());
        const cap = token === null ? undefined : token[1];
        if (cap === undefined || !HCL_VALID_CAPS.has(cap)) {
          invalid.push(`line ${idx + 1}: invalid capability token: ${item}`);
        } else caps.push(cap);
      }
    }
    if (caps.length === 0) invalid.push(`line ${idx + 1}: empty capabilities list is forbidden`);
    if (new Set(caps).size !== caps.length) invalid.push(`line ${idx + 1}: duplicate capability tokens: ${line}`);
    blocks.push({ path: openPath, capabilities: caps });
  });
  if (openPath !== null) invalid.push(`unclosed block: ${openPath}`);
  if (quotes % 2 !== 0) invalid.push('odd count of quotes');
  if (braces !== 0) invalid.push('brace total is not zero');
  return { blocks, invalid };
}

/**
 * Vault path-glob semantics (string model): '+' consumes exactly one segment
 * of non-'/' characters (and the pattern's following '/' must then exist in
 * the path), '*' matches zero or more of ANY character including '/'. Needed
 * to prove the rendered wildcards actually cover the ratified 7-segment
 * canonical wire path — and that a '…/+/*' pattern does NOT match a path that
 * ends at the '+' segment.
 */
function vaultGlobMatches(glob: string, path: string): boolean {
  const source = [...glob]
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '+') return '[^/]+';
      return /[.*+?^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
    })
    .join('');
  return new RegExp('^' + source + '$').test(path);
}

const TENANT_WILDCARD_SCOPES: readonly VaultPrefixScope[] = [
  { mount: 'secret', pathPrefix: 'du/tenants/+/connectors/+/accounts' },
];
const HCL_SCOPE_SETS: readonly (readonly VaultPrefixScope[])[] = [VAULT_DEV_SCOPES, TENANT_WILDCARD_SCOPES];
const WILDCARD_DATA_GLOB = 'secret/data/du/tenants/+/connectors/+/accounts/*';
const WILDCARD_METADATA_GLOB = 'secret/metadata/du/tenants/+/connectors/+/accounts/*';
const CANON_WIRE_DATA = 'secret/data/' + CANON_PATH;
const CANON_WIRE_METADATA = 'secret/metadata/' + CANON_PATH;

describe('W-VAULT-POLICY-HCL-IDENTITY-1 — rendered HCL is structurally well-formed', () => {
  it('every actor renders balanced, well-formed blocks with valid Vault capabilities only', () => {
    for (const actor of VAULT_ACTORS) {
      for (const scopes of HCL_SCOPE_SETS) {
        const { blocks, invalid } = parseHclBlocks(renderVaultPolicyHcl(actor, scopes));
        expect(invalid).toEqual([]);
        for (const block of blocks) {
          expect(block.capabilities.length).toBeGreaterThan(0);
          for (const cap of block.capabilities) expect(HCL_VALID_CAPS.has(cap)).toBe(true);
          expect(block.path.startsWith('secret/data/') || block.path.startsWith('secret/metadata/')).toBe(true);
        }
      }
    }
  });

  it('rendering is deterministic: repeated calls are byte-identical', () => {
    for (const actor of VAULT_ACTORS) {
      for (const scopes of HCL_SCOPE_SETS) {
        expect(renderVaultPolicyHcl(actor, scopes)).toBe(renderVaultPolicyHcl(actor, scopes));
      }
    }
  });

  it('write-family caps appear only on data paths; data paths never carry list/sudo/deny', () => {
    for (const actor of VAULT_ACTORS) {
      for (const scopes of HCL_SCOPE_SETS) {
        const { blocks } = parseHclBlocks(renderVaultPolicyHcl(actor, scopes));
        for (const block of blocks) {
          if (block.path.startsWith('secret/metadata/')) {
            expect(block.capabilities).toEqual(block.capabilities.filter((c) => c === 'read' || c === 'list'));
          } else {
            expect(block.capabilities).toEqual(
              block.capabilities.filter((c) => c === 'read' || c === 'create' || c === 'update'),
            );
          }
        }
      }
    }
  });
});

describe('orchestrator-writer HCL — create/update on data, metadata read only, NEVER plaintext read', () => {
  it('default dev scope renders EXACTLY the deployed block set', () => {
    expect(parseHclBlocks(renderVaultPolicyHcl('orchestrator-writer')).blocks).toEqual([
      { path: 'secret/data/du/connector/*', capabilities: ['create', 'update'] },
      { path: 'secret/metadata/du/connector/*', capabilities: ['read', 'list'] },
    ]);
  });

  it('tenant-wildcard scope renders the canonical tree with the same capability split', () => {
    expect(parseHclBlocks(renderVaultPolicyHcl('orchestrator-writer', TENANT_WILDCARD_SCOPES)).blocks).toEqual([
      { path: WILDCARD_DATA_GLOB, capabilities: ['create', 'update'] },
      { path: WILDCARD_METADATA_GLOB, capabilities: ['read', 'list'] },
    ]);
  });

  it('writer holds exactly ONE data block and its capabilities never include read (both scope sets)', () => {
    for (const scopes of HCL_SCOPE_SETS) {
      const dataBlocks = parseHclBlocks(renderVaultPolicyHcl('orchestrator-writer', scopes)).blocks.filter((b) =>
        b.path.startsWith('secret/data/'),
      );
      expect(dataBlocks).toHaveLength(1);
      expect(dataBlocks[0]?.capabilities).toEqual(['create', 'update']);
    }
  });
});

describe('connector-reader HCL — read on data + metadata, ZERO write capability', () => {
  it('default dev scope renders EXACTLY the deployed block set', () => {
    expect(parseHclBlocks(renderVaultPolicyHcl('connector-reader')).blocks).toEqual([
      { path: 'secret/data/du/connector/*', capabilities: ['read'] },
      { path: 'secret/metadata/du/connector/*', capabilities: ['read'] },
    ]);
  });

  it('tenant-wildcard scope renders read-only on both layers and nothing else', () => {
    expect(parseHclBlocks(renderVaultPolicyHcl('connector-reader', TENANT_WILDCARD_SCOPES)).blocks).toEqual([
      { path: WILDCARD_DATA_GLOB, capabilities: ['read'] },
      { path: WILDCARD_METADATA_GLOB, capabilities: ['read'] },
    ]);
  });

  it('no reader block grants anything but "read" (create/update/patch/delete/list/sudo all absent)', () => {
    for (const scopes of HCL_SCOPE_SETS) {
      const { blocks } = parseHclBlocks(renderVaultPolicyHcl('connector-reader', scopes));
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) expect(block.capabilities).toEqual(['read']);
    }
  });
});

describe('worker and browser HCL — fail closed, not a single capability rendered', () => {
  it.each(['worker', 'browser'] as VaultActor[])('%s renders zero path blocks and no capabilities keyword', (actor) => {
    for (const scopes of HCL_SCOPE_SETS) {
      const hcl = renderVaultPolicyHcl(actor, scopes);
      const { blocks, invalid } = parseHclBlocks(hcl);
      expect(invalid).toEqual([]);
      expect(blocks).toEqual([]);
      expect(hcl).not.toContain('path "');
      expect(hcl).not.toContain('capabilities');
      expect(hcl).toContain('NO Vault access');
    }
  });

  it('an actor outside VAULT_ACTORS fails closed the same way (no identity, no blocks)', () => {
    for (const ghost of ['root', 'approle-admin', ''] as unknown as VaultActor[]) {
      const { blocks } = parseHclBlocks(renderVaultPolicyHcl(ghost));
      expect(blocks).toEqual([]);
      expect(vaultPolicyFor(ghost).hasVaultIdentity).toBe(false);
    }
  });
});

describe('writer/reader rendered identities are absolutely disjoint', () => {
  const blockKey = (b: HclBlock) => b.path + ' -> ' + [...b.capabilities].sort().join('+');
  it('no identical path+capabilities block is granted to both roles under the same scopes', () => {
    for (const scopes of HCL_SCOPE_SETS) {
      const writer = parseHclBlocks(renderVaultPolicyHcl('orchestrator-writer', scopes)).blocks.map(blockKey);
      const reader = parseHclBlocks(renderVaultPolicyHcl('connector-reader', scopes)).blocks.map(blockKey);
      expect(writer.filter((k) => reader.includes(k))).toEqual([]);
    }
  });

  it('on data paths writer∩reader capability sets are empty (write-only vs read-only split)', () => {
    for (const scopes of HCL_SCOPE_SETS) {
      const writerCaps = parseHclBlocks(renderVaultPolicyHcl('orchestrator-writer', scopes)).blocks
        .filter((b) => b.path.startsWith('secret/data/'))
        .flatMap((b) => b.capabilities);
      const readerCaps = parseHclBlocks(renderVaultPolicyHcl('connector-reader', scopes)).blocks
        .filter((b) => b.path.startsWith('secret/data/'))
        .flatMap((b) => b.capabilities);
      expect(writerCaps.filter((c) => readerCaps.includes(c))).toEqual([]);
      expect([...writerCaps].sort()).toEqual(['create', 'update']);
      expect(readerCaps).toEqual(['read']);
    }
  });
});

describe('rendered wildcards cover the ratified 7-segment canonical wire path', () => {
  it('both writer and reader blocks glob-match the canonical data and metadata wire paths', () => {
    for (const actor of ['orchestrator-writer', 'connector-reader'] as VaultActor[]) {
      const { blocks } = parseHclBlocks(renderVaultPolicyHcl(actor, TENANT_WILDCARD_SCOPES));
      expect(blocks).toHaveLength(2);
      for (const block of blocks) {
        const wire = block.path.startsWith('secret/data/') ? CANON_WIRE_DATA : CANON_WIRE_METADATA;
        expect(vaultGlobMatches(block.path, wire)).toBe(true);
      }
    }
    // a foreign mount stays outside every rendered glob
    const foreign = parseHclBlocks(renderVaultPolicyHcl('connector-reader', TENANT_WILDCARD_SCOPES)).blocks;
    for (const block of foreign) {
      expect(vaultGlobMatches(block.path, 'kv-prod' + block.path.slice('secret'.length))).toBe(false);
    }
  });

  it('renderer limit pinned (see Δ6): suffix is always "/*"; the packet literal "…accounts/+" alone is not producible', () => {
    for (const scopes of HCL_SCOPE_SETS) {
      for (const actor of ['orchestrator-writer', 'connector-reader'] as VaultActor[]) {
        for (const block of parseHclBlocks(renderVaultPolicyHcl(actor, scopes)).blocks) {
          expect(block.path.endsWith('/*')).toBe(true);
        }
      }
    }
    // '…accounts/*' (the producible superset) also accepts deeper-than-canonical paths…
    expect(vaultGlobMatches(WILDCARD_DATA_GLOB, CANON_WIRE_DATA + '/nested')).toBe(true);
    // …while the literal packet shape '…accounts/+/*' would MISS the exact canonical path.
    expect(vaultGlobMatches('secret/data/du/tenants/+/connectors/+/accounts/+/*', CANON_WIRE_DATA)).toBe(false);
  });
});

describe('deployed infra/vault/policies stay byte-identical to the renderer', () => {
  it('orchestrator-writer.hcl / connector-reader.hcl / worker-browser.hcl equal renderVaultPolicyHcl output', () => {
    const dir = join(__dirname, '..', '..', '..', 'infra', 'vault', 'policies');
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['orchestrator-writer.hcl', renderVaultPolicyHcl('orchestrator-writer')],
      ['connector-reader.hcl', renderVaultPolicyHcl('connector-reader')],
      ['worker-browser.hcl', renderVaultPolicyHcl('worker') + renderVaultPolicyHcl('browser')],
    ];
    for (const [file, rendered] of expectations) {
      const deployed = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      expect([file, deployed]).toEqual([file, rendered]);
    }
  });
});
