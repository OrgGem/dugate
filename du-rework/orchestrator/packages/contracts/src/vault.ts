import { z } from 'zod';

/**
 * VAULT-01 (tasks/SEC-OIDC-VAULT-2026-09-24.md): typed Vault KV v2 reference
 * + plaintext-secret guard for the Connector revision config.
 *
 * A VaultKv2Ref is a POINTER — account/mount/path/key[/version] — that must
 * stay inside the connector account scope SEC-00 approves. The validator is
 * fail-closed against every traversal or smuggling vector: '..' anywhere,
 * encoded separators (%2f/%5c — '%' is banned outright), backslashes,
 * whitespace, control characters, empty/leading/trailing segments.
 *
 * Secrets themselves must NEVER persist as plaintext in the revision config
 * JSONB (docs 04/08): ConnectorRevisionConfigSchema rejects secret-bearing
 * header names AND credential-shaped header values, so the only compliant
 * route for credentials is a VaultKv2Ref resolved by the VAULT-02 service
 * identity. Issue messages echo the offending HEADER NAME (never a value).
 */

/** Leading alnum, then alnum/'.'/'_'/'-'; <=128. */
const VAULT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VAULT_MOUNT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VAULT_ACCOUNT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VAULT_TENANT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VAULT_PATH_MAX_SEGMENTS = 16;

function hasForbiddenChars(value: string): boolean {
  return (
    value.includes('..') ||
    value.includes('~') ||
    value.includes(String.fromCharCode(92)) || // backslash
    value.includes('%') ||
    // whitespace (space, tab, newline, ...) and C0/C1 controls + DEL
    /\s/.test(value) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

function segmentIssue(
  value: string,
  path: (string | number)[],
  label: string,
  ctx: z.RefinementCtx,
): void {
  if (value.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: label + ' must be a non-empty segment' });
    return;
  }
  if (hasForbiddenChars(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: label + ' contains forbidden characters (traversal, encoded separators, whitespace or control characters)',
    });
    return;
  }
  if (!VAULT_SEGMENT.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: label + ' must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
    });
  }
}

const VaultVersionSchema = z
  .number()
  .int()
  .positive()
  .max(2147483647); // Vault KV v2 versions are 32-bit positive ints

interface VaultRefFields {
  account: string;
  mount: string;
  path: string;
  key: string;
}

function vaultKv2Refine(ref: VaultRefFields, ctx: z.RefinementCtx): void {
  if (ref.account.length === 0 || hasForbiddenChars(ref.account) || !VAULT_ACCOUNT.test(ref.account)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['account'],
      message: 'account must be a lowercase scope id matching ^[a-z0-9][a-z0-9._-]{0,63}$',
    });
  }
  if (ref.mount.length === 0 || hasForbiddenChars(ref.mount) || !VAULT_MOUNT.test(ref.mount)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mount'],
      message: 'mount must match ^[a-z0-9][a-z0-9._-]{0,63}$ (no slashes, no traversal, no encoded separators)',
    });
  }
  segmentIssue(ref.key, ['key'], 'key', ctx);
  const segments = ref.path.split('/');
  if (segments.length < 1 || segments.length > VAULT_PATH_MAX_SEGMENTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['path'],
      message: 'path must have 1-' + VAULT_PATH_MAX_SEGMENTS + ' segments',
    });
  }
  segments.forEach((segment, i) => segmentIssue(segment, ['path', i], 'path[' + i + ']', ctx));
}

const VaultKv2RefObject = z
  .object({
    account: z.string(),
    mount: z.string(),
    path: z.string(),
    key: z.string(),
    version: VaultVersionSchema.optional(),
  })
  .strict();

/**
 * KV v2 read pointer. 'version' optional -> LATEST read (the only allowed
 * drift once SEC-00 ships a default); pins MUST use VaultKv2PinSchema.
 */
export const VaultKv2RefSchema = VaultKv2RefObject.superRefine(vaultKv2Refine);
export type VaultKv2Ref = z.infer<typeof VaultKv2RefSchema>;

export interface VaultAccountPathScope {
  /** Tenant ID from the authenticated invocation grant, when checking a read. */
  tenantId?: string;
  /** Connector ID from the signed grant or the trusted revision being written. */
  connectorId: string;
}

/**
 * The only canonical KV path for a tenant-owned connector account. This
 * checks exact path segments (not a string prefix) against the connector,
 * optional tenant scope, and source account. Call
 * matchesVaultRevisionBinding when a separately stored revision account ID is
 * available.
 */
export function matchesVaultAccountPath(
  ref: Pick<VaultKv2Ref, 'account' | 'path'>,
  scope: VaultAccountPathScope,
): boolean {
  const segments = ref.path.split('/');
  if (segments.length !== 7) return false;
  const [, , tenantId, , connectorId, , accountId] = segments;
  if (
    !tenantId
    || !VAULT_TENANT.test(tenantId)
    || !VAULT_SEGMENT.test(scope.connectorId)
    || !VAULT_ACCOUNT.test(ref.account)
  ) return false;
  return segments[0] === 'du'
    && segments[1] === 'tenants'
    && segments[3] === 'connectors'
    && segments[5] === 'accounts'
    && connectorId === scope.connectorId
    && accountId === ref.account
    && (scope.tenantId === undefined || tenantId === scope.tenantId);
}

/**
 * Immutable revision pin: version is REQUIRED so a pinned revision can never
 * silently follow a new secret version (SEC-00 "revision pin immutable
 * source/version").
 */
export const VaultKv2PinSchema = VaultKv2RefObject.extend({
  version: VaultVersionSchema,
}).superRefine(vaultKv2Refine);
export type VaultKv2Pin = z.infer<typeof VaultKv2PinSchema>;

/**
 * Persisted connector revision credential source. New writes use `vault-kv2`;
 * `vault-kv-v2` remains an explicit read alias for early VAULT-05 snapshots.
 * The transform canonicalizes that alias before it reaches service logic.
 */
const VaultKv2CredentialSource = VaultKv2RefObject.extend({
  version: VaultVersionSchema,
  kind: z.literal('vault-kv2'),
}).superRefine(vaultKv2Refine);
const VaultKvV2CredentialSourceCompatibility = VaultKv2RefObject.extend({
  version: VaultVersionSchema,
  kind: z.literal('vault-kv-v2'),
}).superRefine(vaultKv2Refine);
export const LegacyDbCredentialSourceSchema = z
  .object({ kind: z.literal('legacy-db'), credentialRef: z.string().min(1).max(512) })
  .strict();
export const ConnectorCredentialSourceSchema = z
  .union([
    LegacyDbCredentialSourceSchema,
    VaultKv2CredentialSource,
    VaultKvV2CredentialSourceCompatibility,
  ])
  .transform((source) => source.kind === 'vault-kv-v2' ? { ...source, kind: 'vault-kv2' as const } : source);
export type ConnectorCredentialSource = z.infer<typeof ConnectorCredentialSourceSchema>;
export type VaultCredentialSource = Extract<ConnectorCredentialSource, { kind: 'vault-kv2' }>;

/** Trusted coordinates stored independently on a connector revision row. */
export const ConnectorRevisionBindingSchema = z.object({
  tenantId: z.string().regex(VAULT_TENANT),
  connectorId: z.string().regex(VAULT_SEGMENT),
  accountId: z.string().regex(VAULT_ACCOUNT),
}).strict();
export type ConnectorRevisionBinding = z.infer<typeof ConnectorRevisionBindingSchema>;

/**
 * Checks a parsed Vault source against the independent revision binding.
 * Keeping this check in contracts makes writers and readers use the same
 * exact-segment rule and prevents the source from serving as its own trust
 * anchor.
 */
export function matchesVaultRevisionBinding(source: unknown, binding: unknown): boolean {
  const parsedSource = ConnectorCredentialSourceSchema.safeParse(source);
  const parsedBinding = ConnectorRevisionBindingSchema.safeParse(binding);
  if (!parsedSource.success || !parsedBinding.success || parsedSource.data.kind !== 'vault-kv2') return false;
  return parsedSource.data.account === parsedBinding.data.accountId
    && matchesVaultAccountPath(parsedSource.data, parsedBinding.data);
}

/** VAULT-01 revision lifecycle (migration 006; 'DISABLED' is retired away). */
export const ConnectorRevisionStateSchema = z.enum(['PENDING', 'ACTIVE', 'RETIRED']);
export type ConnectorRevisionState = z.infer<typeof ConnectorRevisionStateSchema>;

/** Header names whose presence means a plaintext credential (docs 08). */
const SECRET_HEADER_NAMES = [
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'x-api-key',
  'x-apikey',
  'api-key',
  'apikey',
  'x-goog-api-key',
  'x-amz-security-token',
  'x-session-token',
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
];

function headerNameIsSecret(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_HEADER_NAMES.some(
    (s) => n === s || n.startsWith(s + '-') || n.endsWith('-' + s) || n.startsWith(s + '_') || n.endsWith('_' + s),
  );
}

/** Credential-shaped values that must never live in config JSONB. */
const SECRET_VALUE = new RegExp(
  [
    '^(bearer|basic|digest|token|apikey|pop)\\s', // scheme-prefixed
    '^sk-[A-Za-z0-9_-]{8,}', // openai-style
    '^sk_live_|^sk_test_|^pk_live_|^pk_test_',
    '^gh[pousr]_', // github
    '^xox[baprs]-', // slack
    '^AKIA[0-9A-Z]{16}', // aws access key id
    '^-----BEGIN', // PEM private material
    '(password|passwd|secret|token|apikey|api_key)[=:]', // inline credentials
    '^[A-Za-z0-9+/_-]{40,}\\.[A-Za-z0-9+/_-]{8,}', // JWT-shaped pair
  ].join('|'),
  'i',
);

/**
 * Connector revision config wire shape (docs 08 GET revisions pane). STRICT:
 * an unknown key (e.g. a bare 'apiKey') fails before it can smuggle secrets.
 */
export const ConnectorRevisionConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    path: z.string().min(1).max(512).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    requestMapping: z.record(z.string(), z.string()).optional(),
    responseMapping: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().min(1).max(600000).default(15000),
    capability: z.string().min(1).optional(),
    /** Selector for the approved provider credential injection point; never a credential value. */
    credentialSlot: z.string().max(128).optional(),
    asyncPollingMode: z.literal('idempotency-key-replay').optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.headers) return;
    for (const [name, value] of Object.entries(cfg.headers)) {
      // NAME first (it is safe to echo); the VALUE never appears in issues.
      if (headerNameIsSecret(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headers', name],
          message:
            'config.headers must not carry secret-bearing header "' +
            name +
            '"; reference credentials via VaultKv2Ref (credentialRef), never plaintext config',
        });
      } else if (SECRET_VALUE.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headers', name],
          message:
            'config.headers."' +
            name +
            '" value looks like a plaintext credential; move it behind a VaultKv2Ref',
        });
      }
    }
  });
export type ConnectorRevisionConfig = z.infer<typeof ConnectorRevisionConfigSchema>;

/**
 * Fail-closed convenience guard for service-side validation. Throws a
 * PLAINTEXT_SECRET_IN_CONFIG error whose message lists header NAMES only.
 */
export function assertNoPlaintextSecrets(config: unknown): ConnectorRevisionConfig {
  const parsed = ConnectorRevisionConfigSchema.safeParse(config);
  if (!parsed.success) {
    const names = parsed.error.issues
      .filter((i) => i.path[0] === 'headers')
      .map((i) => String(i.path[1] ?? ''));
    throw new Error(
      'PLAINTEXT_SECRET_IN_CONFIG' + (names.length > 0 ? ' (headers: ' + [...new Set(names)].join(', ') + ')' : ''),
    );
  }
  return parsed.data;
}
